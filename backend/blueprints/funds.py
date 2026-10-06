"""Mutual funds held outside Kite: list, search, add by hand, SIPs, CAS import.
The work happens in funds_service.py; see its docstring for how they fit in."""
import io
from datetime import datetime

from flask import Blueprint, jsonify, request

import funds_service as funds
from access import require_access
from extensions import db
from models import Fund, FundSip, FundTransaction, FundValue
from tenancy import data_owner

funds_bp = Blueprint("funds", __name__)

MAX_STATEMENT_BYTES = 10 * 1024 * 1024
MAX_AMOUNT = 10_00_00_000


def _bad(message, status=400):
    return jsonify({"success": False, "message": message}), status


def _amount(value):
    try:
        amount = round(float(value), 2)
    except (TypeError, ValueError):
        return None
    return amount if 0 < amount <= MAX_AMOUNT else None


def _date(value):
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").date()
    except ValueError:
        return None


def _sip_fields(body):
    """(amount, day, since) from {"amount", "day", "since"}, or an error message."""
    amount = _amount(body.get("amount"))
    try:
        day = int(body.get("day"))
    except (TypeError, ValueError):
        day = 0
    since = _date(body.get("since")) or funds.ist_today()
    if amount is None:
        return None, "Enter the SIP amount"
    if not 1 <= day <= 31:
        return None, "Pick the SIP day (1–31)"
    if since > funds.ist_today():
        return None, "A SIP can't start in the future"
    return (amount, day, since), None


def _done(**extra):
    funds.value_funds(funds.ist_today())
    db.session.commit()
    return jsonify({"success": True, **extra, "funds": funds.funds_overview()})


@funds_bp.route('/api/funds', methods=['GET'])
@require_access("invest")
def list_funds():
    funds.refresh_if_due()
    return jsonify({"success": True, "funds": funds.funds_overview()})


@funds_bp.route('/api/funds/search', methods=['GET'])
@require_access("invest")
def search_funds():
    query = (request.args.get("q") or "").strip()
    if len(query) < 2:
        return jsonify({"success": True, "results": []})
    try:
        hits = funds.search(query)
    except funds.NavUnavailable as e:
        return _bad(str(e), 503)
    return jsonify({"success": True, "results": [
        {"code": s["code"], "name": s["full_name"], "amc": s["amc"], "nav": s["nav"], "nav_date": s["date"].isoformat()}
        for s in hits
    ]})


@funds_bp.route('/api/funds', methods=['POST'])
@require_access("invest")
def add_fund():
    """{code, amount?, date?, sip?: {amount, day, since}}: a lump sum on a day,
    a monthly SIP since a day (past instalments filled in), or both."""
    body = request.json or {}
    try:
        scheme = funds.scheme_for(body.get("code"))
    except funds.NavUnavailable as e:
        return _bad(str(e), 503)
    if scheme is None:
        return _bad("Pick a fund from the search")
    if scheme["name"].lower() in funds.kite_tracked_names():
        return _bad("Kite already tracks this fund", 409)

    lumpsum = body.get("amount") not in (None, "")
    amount, day = _amount(body.get("amount")), _date(body.get("date")) or funds.ist_today()
    if lumpsum and amount is None:
        return _bad("Enter the amount invested")
    if lumpsum and day > funds.ist_today():
        return _bad("That date is in the future")
    sip, error = _sip_fields(body["sip"]) if body.get("sip") else (None, None)
    if error:
        return _bad(error)
    if not lumpsum and sip is None:
        return _bad("Enter an amount, a SIP, or both")

    try:
        # A SIP belongs with the statement's folio when there is one, so the
        # next import replaces the instalments it covers instead of adding to them.
        fund = (Fund.query.filter(Fund.amfi_code == scheme["code"], Fund.folio_ref != funds.MANUAL_FOLIO)
                .order_by(Fund.units.desc()).first()) if sip and not lumpsum else None
        fund = fund or funds.manual_fund(scheme)
        if lumpsum:
            funds.add_lumpsum(fund, amount, day)
        if sip:
            funds.start_sip(fund, *sip)
            funds.process_sips(funds.ist_today())
        return _done(added=scheme["name"])
    except funds.NavUnavailable as e:
        db.session.rollback()
        return _bad(str(e), 503)


@funds_bp.route('/api/funds/<code>', methods=['DELETE'])
@require_access("invest")
def remove_fund(code):
    """The fund in every folio, with its transactions, SIPs and history."""
    rows = Fund.query.filter_by(amfi_code=str(code)).all()
    if not rows:
        return _bad("No such fund", 404)
    ids = [f.id for f in rows]
    FundSip.query.filter(FundSip.fund_id.in_(ids)).delete(synchronize_session=False)
    FundTransaction.query.filter(FundTransaction.fund_id.in_(ids)).delete(synchronize_session=False)
    FundValue.query.filter(FundValue.owner_email == data_owner(), FundValue.amfi_code == str(code)).delete(synchronize_session=False)
    for f in rows:
        db.session.delete(f)
    db.session.flush()
    return _done()


@funds_bp.route('/api/funds/<code>/sip', methods=['POST'])
@require_access("invest")
def add_sip(code):
    sip, error = _sip_fields(request.json or {})
    if error:
        return _bad(error)
    fund = (Fund.query.filter(Fund.amfi_code == str(code))
            .order_by((Fund.folio_ref == funds.MANUAL_FOLIO).asc(), Fund.units.desc()).first())
    if fund is None:
        return _bad("No such fund", 404)
    try:
        funds.start_sip(fund, *sip)
        funds.process_sips(funds.ist_today())
        return _done()
    except funds.NavUnavailable as e:
        db.session.rollback()
        return _bad(str(e), 503)


@funds_bp.route('/api/funds/sips/<int:sip_id>', methods=['DELETE'])
@require_access("invest")
def stop_sip(sip_id):
    """Stops adding instalments; the ones already added stay."""
    sip = FundSip.query.filter_by(id=sip_id).first()
    if sip is None:
        return _bad("No such SIP", 404)
    sip.active = False
    db.session.commit()
    return jsonify({"success": True, "funds": funds.funds_overview()})


@funds_bp.route('/api/funds/import', methods=['POST'])
@require_access("invest")
def import_statement():
    """A CAS PDF (form field "file") and its password ("password"). Read in
    memory: neither the PDF nor the password is kept or logged."""
    upload = request.files.get("file")
    if upload is None:
        return _bad("Choose your CAS PDF")
    data = upload.read(MAX_STATEMENT_BYTES + 1)
    if len(data) > MAX_STATEMENT_BYTES:
        return _bad("That PDF is too large")
    if not data.startswith(b"%PDF"):
        return _bad("That isn't a PDF")
    try:
        cas = funds.parse_cas(io.BytesIO(data), request.form.get("password") or "")
    except funds.StatementError as e:
        return _bad(str(e))
    finally:
        del data
    try:
        summary = funds.import_statement(cas, funds.ist_today())
        db.session.commit()
    except funds.StatementError as e:
        db.session.rollback()
        return _bad(str(e))
    except funds.NavUnavailable as e:
        db.session.rollback()
        return _bad(str(e), 503)
    return jsonify({"success": True, **summary, "funds": funds.funds_overview()})
