"""Stocks and ETFs added by hand: list, search, buy, sell, remove. The work
happens in stocks_service.py; see its docstring for how they fit in."""
from datetime import datetime

from flask import Blueprint, jsonify, request

import stocks_service as stocks
from access import require_access
from extensions import db
from models import Stock, StockTrade, StockValue
from tenancy import data_owner

stocks_bp = Blueprint("stocks", __name__)


def _bad(message, status=400):
    return jsonify({"success": False, "message": message}), status


def _number(value):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    return n if n == n else 0.0   # NaN is no number


def _day(value):
    if value in (None, ""):
        return stocks.ist_today()
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").date()
    except ValueError:
        return None


def _done(**extra):
    stocks.changed()
    db.session.commit()
    rows, quoted = stocks.overview()
    return jsonify({"success": True, **extra, "stocks": rows, "quoted_at": quoted})


@stocks_bp.route('/api/stocks', methods=['GET'])
@require_access("invest")
def list_stocks():
    stocks.refresh_if_due()
    rows, quoted = stocks.overview()
    return jsonify({"success": True, "stocks": rows, "quoted_at": quoted})


@stocks_bp.route('/api/stocks/search', methods=['GET'])
@require_access("invest")
def search_stocks():
    query = (request.args.get("q") or "").strip()
    if len(query) < 2:
        return jsonify({"success": True, "results": []})
    try:
        return jsonify({"success": True, "results": stocks.search(query)})
    except stocks.ListUnavailable as e:
        return _bad(str(e), 503)


def _trade(stock, body, kind):
    day = _day(body.get("date"))
    if day is None:
        raise stocks.StockError("That isn't a date")
    stocks.trade(stock, kind, _number(body.get("quantity")), _number(body.get("price")), day)


@stocks_bp.route('/api/stocks', methods=['POST'])
@require_access("invest")
def add_stock():
    """{symbol, quantity, price, date?}: a buy, of a stock not held before or one that is."""
    body = request.json or {}
    try:
        listed = stocks.lookup(body.get("symbol"))
    except stocks.ListUnavailable as e:
        return _bad(str(e), 503)
    if listed is None:
        return _bad("Pick a stock from the search")
    if listed["symbol"] in stocks.kite_symbols():
        return _bad("Kite already tracks this stock", 409)
    stock = Stock.query.filter_by(symbol=listed["symbol"]).first()
    if stock is None:
        stock = Stock(id=stocks._new_id(), symbol=listed["symbol"], name=listed["name"], isin=listed["isin"],
                      quantity=0.0, invested=0)
        db.session.add(stock)
        db.session.flush()
    try:
        _trade(stock, body, "BUY")
    except stocks.StockError as e:
        db.session.rollback()
        return _bad(str(e))
    return _done(added=stock.symbol)


def _held(symbol):
    return Stock.query.filter_by(symbol=str(symbol).upper()).first()


@stocks_bp.route('/api/stocks/<symbol>/trades', methods=['POST'])
@require_access("invest")
def add_trade(symbol):
    """{kind: BUY | SELL, quantity, price, date?}"""
    stock = _held(symbol)
    if stock is None:
        return _bad("No such stock", 404)
    body = request.json or {}
    try:
        _trade(stock, body, str(body.get("kind") or "").upper())
    except stocks.StockError as e:
        db.session.rollback()
        return _bad(str(e))
    return _done()


@stocks_bp.route('/api/stocks/<symbol>/trades/<int:trade_id>', methods=['DELETE'])
@require_access("invest")
def remove_trade(symbol, trade_id):
    """A trade entered by mistake; the totals are worked out again without it."""
    stock = _held(symbol)
    row = StockTrade.query.filter_by(id=trade_id, stock_id=stock.id).first() if stock else None
    if row is None:
        return _bad("No such trade", 404)
    db.session.delete(row)
    db.session.flush()
    try:
        stocks.replay(stock, StockTrade.query.filter_by(stock_id=stock.id).all())
    except stocks.StockError as e:
        db.session.rollback()
        return _bad(f"{e}, so that buy can't go")
    if not StockTrade.query.filter_by(stock_id=stock.id).first():
        return remove_stock(symbol)
    return _done()


@stocks_bp.route('/api/stocks/<symbol>', methods=['DELETE'])
@require_access("invest")
def remove_stock(symbol):
    """The stock, its trades and its history."""
    stock = _held(symbol)
    if stock is None:
        return _bad("No such stock", 404)
    StockTrade.query.filter_by(stock_id=stock.id).delete(synchronize_session=False)
    StockValue.query.filter(StockValue.owner_email == data_owner(), StockValue.symbol == stock.symbol).delete(synchronize_session=False)
    db.session.delete(stock)
    db.session.flush()
    return _done()
