from flask import Blueprint, request, jsonify
from datetime import datetime, date, timedelta, timezone
import os
import re
import json
import pytz
import requests
from extensions import (
    db,
    SHEETS_URL, JWT_SECRET, ALLOWED_EMAILS, ADMIN_USER, ADMIN_PASS,
    KITE_API_KEY, KITE_API_SECRET, TMDB_API_KEY,
)
from models import *
from access import require_api_key, require_admin, require_access, current_access, owner_only

import hashlib
from dateutil.relativedelta import relativedelta
from pyxirr import xirr

invest_bp = Blueprint("invest", __name__)

@invest_bp.route('/api/cron/process-recurring', methods=['POST'])
@require_access("invest")
def process_recurring():
    if request.method == 'OPTIONS': 
        return '', 200
    
    """Lazy Cron: Processes auto-compounding assets and recurring additions"""
    today = datetime.now(pytz.timezone('Asia/Kolkata')).date()
    processed = 0

    # 1. AUTO-COMPOUND FDs & ASSETS (Quarterly Compounding)
    assets_to_update = ManualAsset.query.filter(ManualAsset.interest_rate.isnot(None), ManualAsset.start_date.isnot(None)).all()
    for asset in assets_to_update:
        # Stop compounding if it has passed maturity
        end_date = min(today, asset.maturity_date) if asset.maturity_date else today
        days_passed = (end_date - asset.start_date).days
        
        if days_passed > 0:
            years = days_passed / 365.25
            rate = asset.interest_rate / 100.0
            
            new_value = asset.invested_value * ((1 + (rate / 4)) ** (4 * years))
            
            # Only flag as processed if the value actually ticked up
            if round(new_value, 2) > asset.current_value:
                asset.current_value = round(new_value, 2)
                asset.last_updated = today
                processed += 1

    # 2. PROCESS RECURRING ADDITIONS (EPF, RD, etc.)
    due_tasks = RecurringTask.query.filter(RecurringTask.is_active == True, RecurringTask.next_run_date <= today).all()
    
    for task in due_tasks:
        asset = ManualAsset.query.filter_by(name=task.asset_name).first()
        if asset:
            asset.invested_value += task.amount_to_add
            # Only add to current_value if it's not being auto-compounded by the block above
            if not asset.interest_rate: 
                asset.current_value += task.amount_to_add
                
            asset.last_updated = today
            
            # Move the next run date forward based on the selected unit
            if task.interval_unit == 'days':
                task.next_run_date = task.next_run_date + relativedelta(days=task.interval_value)
            elif task.interval_unit == 'years':
                task.next_run_date = task.next_run_date + relativedelta(years=task.interval_value)
            else:
                task.next_run_date = task.next_run_date + relativedelta(months=task.interval_value)
            
            processed += 1

    if processed > 0:
        update_latest_portfolio_snapshot()
        db.session.commit()
        
    return jsonify({"success": True, "processed": processed})
@invest_bp.route('/api/investments/xirr', methods=['GET'])
@require_access("invest")
def get_portfolio_xirr():
    try:
        # 1. Get all Investment transactions (Cash Outflows)
        inv_txs = Transaction.query.filter_by(type='Investment').order_by(Transaction.date.asc()).all()
        
        if not inv_txs:
            return jsonify({"success": True, "xirr": 0.0})

        dates = [tx.date for tx in inv_txs]
        # XIRR requires outflows to be negative numbers
        amounts = [-abs(tx.amount) for tx in inv_txs] 

        # 2. Get the current total portfolio value (Cash Inflow)
        latest_snap = PortfolioSnapshot.query.order_by(PortfolioSnapshot.date.desc()).first()
        
        if not latest_snap:
            return jsonify({"success": True, "xirr": 0.0})

        # Add today's value as the final positive cash flow
        dates.append(datetime.now().date())
        amounts.append(latest_snap.grand_total_curr)

        # 3. Calculate XIRR
        portfolio_xirr = xirr(dates, amounts)
        
        # Convert to a readable percentage format
        xirr_pct = (portfolio_xirr * 100) if portfolio_xirr else 0.0
        
        return jsonify({"success": True, "xirr": round(xirr_pct, 2)})

    except Exception as e:
        print(f"❌ Error calculating XIRR: {str(e)}")
        return jsonify({"success": False, "message": str(e)})
# ---- INVESTMENTS ----
@invest_bp.route('/api/investments', methods=['GET'])
@require_access("invest")
def get_investments():
    records = PortfolioSnapshot.query.order_by(PortfolioSnapshot.date.desc()).all()

    result = [
        {
            "id": r.id,
            "date": r.date.strftime("%Y-%m-%d"),
            # Backward compatibility mapping for current frontend
            "inv_stocks": r.total_equity_inv,
            "curr_stocks": r.total_equity_curr,
            "inv_mf": r.total_mf_inv,
            "curr_mf": r.total_mf_curr,
            "total_inv": r.grand_total_inv,
            "total_curr": r.grand_total_curr,
            
            # New data ready for Phase 2 UI
            "inv_fixed": r.total_fixed_income_inv,
            "curr_fixed": r.total_fixed_income_curr,
            "inv_prov": r.total_provident_inv,
            "curr_prov": r.total_provident_curr,
            "inv_gold": r.total_gold_inv,
            "curr_gold": r.total_gold_curr,
            
            # Mocking the old percentage fields dynamically
            "ret_pct_stocks": ((r.total_equity_curr - r.total_equity_inv) / r.total_equity_inv * 100) if r.total_equity_inv > 0 else 0,
            "ret_pct_mf": ((r.total_mf_curr - r.total_mf_inv) / r.total_mf_inv * 100) if r.total_mf_inv > 0 else 0,
            "total_ret_pct": ((r.grand_total_curr - r.grand_total_inv) / r.grand_total_inv * 100) if r.grand_total_inv > 0 else 0,
            "status_stocks": "",
            "status_mf": "",
            "total_status": ""
        }
        for r in records
    ]

    return jsonify(result)
@invest_bp.route('/api/cron/tasks', methods=['GET', 'POST', 'OPTIONS'])
@require_access("invest")
def handle_recurring_tasks():
    if request.method == 'OPTIONS': return '', 200
    
    if request.method == 'GET':
        tasks = RecurringTask.query.all()
        return jsonify([{
            "id": t.id, 
            "asset_name": t.asset_name, 
            "amount_to_add": t.amount_to_add, 
            "interval_months": t.interval_months,
            "next_run_date": t.next_run_date.strftime("%Y-%m-%d") if t.next_run_date else None,
            "is_active": t.is_active
        } for t in tasks])
        
    if request.method == 'POST':
        data = request.json
        new_task = RecurringTask(
            id=int(datetime.now().timestamp() * 1000),
            asset_name=data['asset_name'],
            amount_to_add=float(data['amount_to_add']),
            interval_months=int(data.get('interval_months', 1)),
            next_run_date=datetime.strptime(data['next_run_date'], '%Y-%m-%d').date(),
            is_active=True
        )
        db.session.add(new_task)
        db.session.commit()
        return jsonify({"success": True, "message": "Automation added"})
@invest_bp.route('/api/cron/tasks/<int:tid>', methods=['DELETE', 'OPTIONS'])
@require_access("invest")
def delete_recurring_task(tid):
    if request.method == 'OPTIONS': return '', 200
    task = RecurringTask.query.filter_by(id=tid).first()
    if task:
        db.session.delete(task)
        db.session.commit()
        return jsonify({"success": True})
    return jsonify({"success": False, "message": "Task not found"}), 404
def update_latest_portfolio_snapshot():
    """Recalculates manual asset totals for the most recent snapshot so charts
    update instantly. Someone who has never synced Kite gets today's first one."""
    latest_snap = PortfolioSnapshot.query.order_by(PortfolioSnapshot.date.desc()).first()
    manual_assets = ManualAsset.query.all()
    if not latest_snap:
        if not manual_assets:
            return
        latest_snap = PortfolioSnapshot(
            id=int(datetime.now().timestamp() * 1000),
            date=datetime.now(pytz.timezone('Asia/Kolkata')).date(),
            total_equity_inv=0.0, total_equity_curr=0.0, total_mf_inv=0.0, total_mf_curr=0.0,
        )
        db.session.add(latest_snap)
    
    fixed_inv = sum(a.invested_value for a in manual_assets if a.category in ['FD', 'RD', 'Cash'])
    fixed_curr = sum(a.current_value for a in manual_assets if a.category in ['FD', 'RD', 'Cash'])
    prov_inv = sum(a.invested_value for a in manual_assets if a.category in ['EPF', 'PPF', 'NPS'])
    prov_curr = sum(a.current_value for a in manual_assets if a.category in ['EPF', 'PPF', 'NPS'])
    gold_inv = sum(a.invested_value for a in manual_assets if a.category in ['SGB', 'RealEstate'])
    gold_curr = sum(a.current_value for a in manual_assets if a.category in ['SGB', 'RealEstate'])

    latest_snap.total_fixed_income_inv = fixed_inv
    latest_snap.total_fixed_income_curr = fixed_curr
    latest_snap.total_provident_inv = prov_inv
    latest_snap.total_provident_curr = prov_curr
    latest_snap.total_gold_inv = gold_inv
    latest_snap.total_gold_curr = gold_curr
    
    latest_snap.grand_total_inv = latest_snap.total_equity_inv + latest_snap.total_mf_inv + fixed_inv + prov_inv + gold_inv
    latest_snap.grand_total_curr = latest_snap.total_equity_curr + latest_snap.total_mf_curr + fixed_curr + prov_curr + gold_curr
    
    latest_snap.synced = False
    db.session.commit()
@invest_bp.route('/api/manual_assets/<int:aid>', methods=['DELETE'])
@require_access("invest")
def delete_manual_asset(aid):
    asset = ManualAsset.query.filter_by(id=aid).first()
    if asset:
        db.session.delete(asset)
        db.session.commit()
        update_latest_portfolio_snapshot() # <-- Updates Pie Chart instantly
        return jsonify({"success": True})
    return jsonify({"success": False, "message": "Asset not found"}), 404
@invest_bp.route('/api/manual_assets', methods=['GET', 'POST'])
@require_access("invest")
def handle_manual_assets():
    if request.method == 'GET':
        assets = ManualAsset.query.order_by(ManualAsset.category, ManualAsset.name).all()
        tasks = RecurringTask.query.all()
        task_map = {t.asset_name: t for t in tasks}
        
        return jsonify([{
            "id": a.id,
            "category": a.category,
            "name": a.name,
            "invested_value": a.invested_value,
            "current_value": a.current_value,
            "interest_rate": a.interest_rate,
            "start_date": a.start_date.strftime("%Y-%m-%d") if a.start_date else None,
            "maturity_date": a.maturity_date.strftime("%Y-%m-%d") if a.maturity_date else None,
            "last_updated": a.last_updated.strftime("%Y-%m-%d"),
            "is_recurring": a.name in task_map,
            "amount_to_add": task_map[a.name].amount_to_add if a.name in task_map else None,
            "interval_value": task_map[a.name].interval_value if a.name in task_map else None,
            "interval_unit": task_map[a.name].interval_unit if a.name in task_map else None,
            "next_run_date": task_map[a.name].next_run_date.strftime("%Y-%m-%d") if a.name in task_map and task_map[a.name].next_run_date else None
        } for a in assets])
        
    if request.method == 'POST':
        data = request.json
        ist_timezone = pytz.timezone('Asia/Kolkata')
        
        start_date = datetime.strptime(data['start_date'], '%Y-%m-%d').date() if data.get('start_date') else None
        mat_date = datetime.strptime(data['maturity_date'], '%Y-%m-%d').date() if data.get('maturity_date') else None
    
        curr_val_raw = data.get('current_value')
        curr_val = float(curr_val_raw) if curr_val_raw else float(data.get('invested_value', 0))

        new_asset = ManualAsset(
            id=int(datetime.now().timestamp() * 1000),
            category=data['category'],
            name=data['name'],
            invested_value=float(data.get('invested_value', 0)),
            current_value=curr_val,
            interest_rate=float(data.get('interest_rate')) if data.get('interest_rate') else None,
            start_date=start_date,
            maturity_date=mat_date,
            last_updated=datetime.now(ist_timezone).date()
        )
        db.session.add(new_asset)
        
        if data.get('is_recurring'):
            new_task = RecurringTask(
                id=int(datetime.now().timestamp() * 1000) + 1,
                asset_name=data['name'],
                amount_to_add=float(data['amount_to_add']),
                interval_value=int(data.get('interval_value', 1)),
                interval_unit=data.get('interval_unit', 'months'),
                next_run_date=datetime.strptime(data['next_run_date'], '%Y-%m-%d').date(),
                is_active=True
            )
            db.session.add(new_task)

        db.session.commit()
        update_latest_portfolio_snapshot()
        return jsonify({"success": True, "message": "Asset & Automation added successfully"})
@invest_bp.route('/api/manual_assets/<int:aid>', methods=['PUT', 'OPTIONS'])
@require_access("invest")
def edit_manual_asset(aid):
    if request.method == 'OPTIONS': return '', 200
    try:
        data = request.json
        asset = ManualAsset.query.filter_by(id=aid).first()
        if not asset: return jsonify({"success": False, "message": "Asset not found"}), 404

        ist_timezone = pytz.timezone('Asia/Kolkata')
        old_name = asset.name
        
        asset.category = data['category']
        asset.name = data['name']
        asset.invested_value = float(data.get('invested_value', 0))
        asset.current_value = float(data.get('current_value', 0))
        asset.interest_rate = float(data.get('interest_rate')) if data.get('interest_rate') else None
        asset.start_date = datetime.strptime(data['start_date'], '%Y-%m-%d').date() if data.get('start_date') else None
        asset.maturity_date = datetime.strptime(data['maturity_date'], '%Y-%m-%d').date() if data.get('maturity_date') else None
        asset.last_updated = datetime.now(ist_timezone).date()

        # Handle Recurring Task updates linked to this asset
        task = RecurringTask.query.filter_by(asset_name=old_name).first()
        
        if data.get('is_recurring'):
            if task:
                task.asset_name = asset.name
                task.amount_to_add = float(data['amount_to_add'])
                task.interval_value = int(data.get('interval_value', 1))
                task.interval_unit = data.get('interval_unit', 'months')
                task.next_run_date = datetime.strptime(data['next_run_date'], '%Y-%m-%d').date()
            else:
                new_task = RecurringTask(
                    id=int(datetime.now().timestamp() * 1000) + 1,
                    asset_name=asset.name,
                    amount_to_add=float(data['amount_to_add']),
                    interval_value=int(data.get('interval_value', 1)),
                    interval_unit=data.get('interval_unit', 'months'),
                    next_run_date=datetime.strptime(data['next_run_date'], '%Y-%m-%d').date(),
                    is_active=True
                )
                db.session.add(new_task)
        else:
            if task: db.session.delete(task)

        db.session.commit()
        update_latest_portfolio_snapshot()
        return jsonify({"success": True})
    except Exception as e:
        db.session.rollback()
        return jsonify({"success": False, "message": str(e)})
@invest_bp.route('/api/equity', methods=['GET'])
@require_access("invest")
def get_equity():
    # Fetch the latest available equity snapshot
    latest_date = db.session.query(db.func.max(EquityHolding.date)).scalar()
    if not latest_date:
        return jsonify([])
        
    records = EquityHolding.query.filter_by(date=latest_date).all()
    return jsonify([{
        "symbol": r.symbol,
        "quantity": r.quantity,
        "average_price": r.average_price,
        "ltp": r.ltp,
        "invested_value": r.invested_value,
        "current_value": r.current_value
    } for r in records])
@invest_bp.route('/api/sync/kite', methods=['POST'])
@require_access("invest")
def sync_kite_direct():
    denied = owner_only()
    if denied: return denied
    print("🔄 Starting direct Kite sync...")
    data = request.json
    request_token = data.get('request_token')
    
    if not request_token:
        return jsonify({"success": False, "message": "Request token is required for Kite API"})

    if not KITE_API_KEY or not KITE_API_SECRET:
        return jsonify({"success": False, "message": "Kite API credentials not configured"})

    try:
        ist_timezone = pytz.timezone('Asia/Kolkata')
        today_date = datetime.now(ist_timezone).date()
        
        # 1. Check if already synced today
        if PortfolioSnapshot.query.filter_by(date=today_date).first():
            return jsonify({"success": False, "message": f"Already synced investments for {today_date.strftime('%d/%m/%Y')}!"})

        # 2. Auth with Kite
        raw = KITE_API_KEY + request_token + KITE_API_SECRET
        checksum = hashlib.sha256(raw.encode('utf-8')).hexdigest()

        token_res = requests.post("https://api.kite.trade/session/token", data={
            "api_key": KITE_API_KEY, "request_token": request_token, "checksum": checksum
        }).json()
        
        if token_res.get('status') != 'success':
            return jsonify({"success": False, "message": "Kite Auth Failed. Token might be expired."})
        
        access_token = token_res['data']['access_token']
        headers = {"Authorization": f"token {KITE_API_KEY}:{access_token}"}

        # ==========================================
        # 3. PROCESS MUTUAL FUNDS
        # ==========================================
        mf_res = requests.get("https://api.kite.trade/mf/holdings", headers=headers).json()
        mf_holdings = mf_res.get('data', [])
        
        # Fetch latest NAVs from AMFI (official source for mfapi.in) to avoid downloading large Kite instruments CSV
        amfi_res = requests.get("https://www.amfiindia.com/spages/NAVAll.txt", timeout=15)
        mf_data_map = {}
        for line in amfi_res.text.splitlines():
            parts = line.split(';')
            if len(parts) >= 8 and parts[0].strip().isdigit():
                isin1, isin2 = parts[1].strip(), parts[2].strip()
                raw_name = parts[3].strip()
                
                # Clean the AMFI name for a cleaner UI (remove plan/option details)
                name = re.sub(r'(?i)\s*-\s*Direct.*', '', raw_name)
                name = re.sub(r'(?i)\s*-\s*Regular.*', '', name)
                name = re.sub(r'(?i)\s*-\s*Growth.*', '', name)
                name = re.sub(r'(?i)\s*-\s*IDCW.*', '', name)
                name = re.sub(r'(?i)\s*-\s*Dividend.*', '', name)
                name = name.strip()
                    
                nav_str = parts[6].strip()
                try:
                    nav = float(nav_str)
                    if isin1 and isin1 != '-': mf_data_map[isin1] = {'nav': nav, 'name': name}
                    if isin2 and isin2 != '-': mf_data_map[isin2] = {'nav': nav, 'name': name}
                except ValueError:
                    continue
        
        mf_total_inv = 0.0
        mf_total_curr = 0.0
        mf_records = []

        for h in mf_holdings:
            raw_symbol = h['tradingsymbol']
            qty, avg_price = float(h['quantity']), float(h['average_price'])
            
            fund_info = mf_data_map.get(raw_symbol)
            if not fund_info or not fund_info['nav']: continue
                
            nav, real_name = fund_info['nav'], fund_info['name']
            inv_val, curr_val = (qty * avg_price), (qty * nav)
            
            mf_total_inv += inv_val
            mf_total_curr += curr_val
            
            mf_records.append(MutualFundHolding(
                id=int(datetime.now().timestamp() * 1000) + len(mf_records),
                date=today_date, symbol=real_name, quantity=qty, average_price=avg_price,
                nav=nav, invested_value=inv_val, current_value=curr_val
            ))

        # ==========================================
        # 4. PROCESS EQUITY (STOCKS)
        # ==========================================
        eq_res = requests.get("https://api.kite.trade/portfolio/holdings", headers=headers).json()
        eq_holdings = eq_res.get('data', [])
        
        eq_total_inv = 0.0
        eq_total_curr = 0.0
        eq_records = []

        for e in eq_holdings:
            qty, avg_price, ltp = e['quantity'], e['average_price'], e['last_price']
            inv_val, curr_val = (qty * avg_price), (qty * ltp)
            
            eq_total_inv += inv_val
            eq_total_curr += curr_val
            
            eq_records.append(EquityHolding(
                id=int(datetime.now().timestamp() * 1000) + e.get('instrument_token', len(eq_records)),
                date=today_date, symbol=e['tradingsymbol'], quantity=qty, average_price=avg_price,
                ltp=ltp, invested_value=inv_val, current_value=curr_val
            ))

        # ==========================================
        # 5. CALCULATE TOTALS (KITE + MANUAL)
        # ==========================================
        manual_assets = ManualAsset.query.all()
        
        fixed_inv = sum(a.invested_value for a in manual_assets if a.category in ['FD', 'RD', 'Cash'])
        fixed_curr = sum(a.current_value for a in manual_assets if a.category in ['FD', 'RD', 'Cash'])
        
        
        prov_inv = sum(a.invested_value for a in manual_assets if a.category in ['EPF', 'PPF', 'NPS'])
        prov_curr = sum(a.current_value for a in manual_assets if a.category in ['EPF', 'PPF', 'NPS'])
        
        gold_inv = sum(a.invested_value for a in manual_assets if a.category == 'SGB')
        gold_curr = sum(a.current_value for a in manual_assets if a.category == 'SGB')

        grand_inv = eq_total_inv + mf_total_inv + fixed_inv + prov_inv + gold_inv
        grand_curr = eq_total_curr + mf_total_curr + fixed_curr + prov_curr + gold_curr

        # ==========================================
        # 6. SAVE TO DATABASE
        # ==========================================
        new_snapshot = PortfolioSnapshot(
            id=int(datetime.now().timestamp() * 1000), 
            date=today_date,
            total_equity_inv=eq_total_inv, total_equity_curr=eq_total_curr,
            total_mf_inv=mf_total_inv, total_mf_curr=mf_total_curr,
            total_fixed_income_inv=fixed_inv, total_fixed_income_curr=fixed_curr,
            total_provident_inv=prov_inv, total_provident_curr=prov_curr,
            total_gold_inv=gold_inv, total_gold_curr=gold_curr,
            grand_total_inv=grand_inv, grand_total_curr=grand_curr
        )
        
        db.session.add(new_snapshot)
        db.session.add_all(mf_records)
        db.session.add_all(eq_records)
        db.session.commit()

        return jsonify({"success": True, "message": f"Successfully synced Combined Portfolio!"})

    except Exception as e:
        print(f"❌ Kite Sync Error: {str(e)}")
        import traceback
        traceback.print_exc()
        db.session.rollback()
        return jsonify({"success": False, "message": str(e)})
@invest_bp.route('/api/investments/<date_str>/equity_holdings', methods=['GET'])
@require_access("invest")
def get_daily_equity_holdings(date_str):
    date_obj = datetime.strptime(date_str, '%Y-%m-%d').date()
    holdings = EquityHolding.query.filter_by(date=date_obj).all()
    return jsonify([{
        "symbol": h.symbol,
        "quantity": h.quantity,
        "average_price": h.average_price,
        "ltp": h.ltp,
        "invested_value": h.invested_value,
        "current_value": h.current_value,
        "ret_pct": ((h.current_value - h.invested_value) / h.invested_value * 100) if h.invested_value > 0 else 0
    } for h in holdings])
@invest_bp.route('/api/sync/investments-to-sheets', methods=['POST'])
@require_access("invest")
def sync_investments_to_sheets():
    denied = owner_only()
    if denied: return denied
    try:
        # Fetch only unsynced snapshots
        unsynced_invs = PortfolioSnapshot.query.filter_by(synced=False).all()
        
        if not unsynced_invs:
            return jsonify({"success": True, "message": "No new investments to sync to Sheets."})

        # Format the payload for Apps Script (mocking the old column structure to prevent Sheets from breaking)
        payload = {
            "type": "investments",
            "data": [
                {
                    "date": inv.date.strftime("%Y-%m-%d"),
                    "inv_stocks": float(inv.total_equity_inv),
                    "curr_stocks": float(inv.total_equity_curr),
                    "ret_pct_stocks": float(((inv.total_equity_curr - inv.total_equity_inv) / inv.total_equity_inv * 100) if inv.total_equity_inv > 0 else 0),
                    "status_stocks": "",
                    "inv_mf": float(inv.total_mf_inv),
                    "curr_mf": float(inv.total_mf_curr),
                    "ret_pct_mf": float(((inv.total_mf_curr - inv.total_mf_inv) / inv.total_mf_inv * 100) if inv.total_mf_inv > 0 else 0),
                    "status_mf": "",
                    "total_inv": float(inv.grand_total_inv),
                    "total_curr": float(inv.grand_total_curr),
                    "total_ret_pct": float(((inv.grand_total_curr - inv.grand_total_inv) / inv.grand_total_inv * 100) if inv.grand_total_inv > 0 else 0),
                    "total_status": ""
                } for inv in unsynced_invs
            ]
        }

        print(f"📡 Sending {len(unsynced_invs)} records to Google Sheets...")
        response = requests.post(SHEETS_URL, json=payload, timeout=60)
        
        if response.status_code == 200:
            for inv in unsynced_invs:
                inv.synced = True
            db.session.commit()
            return jsonify({"success": True, "message": f"Successfully synced {len(unsynced_invs)} records to Sheets!"})
        else:
            return jsonify({"success": False, "message": f"Sheets error: {response.text}"})

    except Exception as e:
        print(f"❌ Sheets Sync Error: {str(e)}")
        return jsonify({"success": False, "message": str(e)})
@invest_bp.route('/api/investments/<date_str>/holdings', methods=['GET'])
@require_access("invest")
def get_daily_holdings(date_str):
    date_obj = datetime.strptime(date_str, '%Y-%m-%d').date()
    holdings = MutualFundHolding.query.filter_by(date=date_obj).all()
    return jsonify([{
        "symbol": h.symbol,
        "quantity": h.quantity,
        "average_price": h.average_price,
        "nav": h.nav,
        "invested_value": h.invested_value,
        "current_value": h.current_value,
        "ret_pct": ((h.current_value - h.invested_value) / h.invested_value * 100) if h.invested_value > 0 else 0
    } for h in holdings])
@invest_bp.route('/api/assets/list', methods=['GET'])
@require_access("invest")
def get_asset_list():
    # Dynamically pull all unique assets you currently own
    latest_eq_date = db.session.query(db.func.max(EquityHolding.date)).scalar()
    eq_symbols = [r[0] for r in db.session.query(EquityHolding.symbol).filter(EquityHolding.date == latest_eq_date).all()] if latest_eq_date else []
    
    latest_mf_date = db.session.query(db.func.max(MutualFundHolding.date)).scalar()
    mf_symbols = [r[0] for r in db.session.query(MutualFundHolding.symbol).filter(MutualFundHolding.date == latest_mf_date).all()] if latest_mf_date else []
    
    manual_assets = ManualAsset.query.all()
    
    return jsonify({
        "EQUITY": sorted(list(set(eq_symbols))),
        "MF": sorted(list(set(mf_symbols))),
        "PROVIDENT": [a.name for a in manual_assets if a.category in ['EPF', 'PPF', 'NPS']],
        "FIXED_INCOME": [a.name for a in manual_assets if a.category in ['FD', 'RD', 'Cash']],
        "GOLD": [a.name for a in manual_assets if a.category in ['SGB', 'RealEstate']]
    })
@invest_bp.route('/api/investments/history', methods=['GET'])
@require_access("invest")
def get_asset_history():
    symbol = request.args.get('symbol')
    asset_type = request.args.get('type') # EQUITY, MF, PROVIDENT, etc.
    
    if not symbol or not asset_type:
        return jsonify([])
        
    data = []
    if asset_type == 'EQUITY':
        history = EquityHolding.query.filter_by(symbol=symbol).order_by(EquityHolding.date.asc()).all()
        data = [{"date": h.date.strftime("%Y-%m-%d"), "Current": h.current_value, "Invested": h.invested_value} for h in history]
    elif asset_type == 'MF':
        history = MutualFundHolding.query.filter_by(symbol=symbol).order_by(MutualFundHolding.date.asc()).all()
        data = [{"date": h.date.strftime("%Y-%m-%d"), "Current": h.current_value, "Invested": h.invested_value} for h in history]
    else:
        # For manual assets, we plot a straight line from creation to today
        asset = ManualAsset.query.filter_by(name=symbol).first()
        if asset:
            ist_timezone = pytz.timezone('Asia/Kolkata')
            today_str = datetime.now(ist_timezone).strftime("%Y-%m-%d")
            data = [
                {"date": asset.last_updated.strftime("%Y-%m-%d"), "Current": asset.current_value, "Invested": asset.invested_value},
                {"date": today_str, "Current": asset.current_value, "Invested": asset.invested_value}
            ]
    return jsonify(data)
