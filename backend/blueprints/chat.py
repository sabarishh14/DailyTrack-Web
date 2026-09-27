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
from access import require_api_key, require_admin, require_access, current_access

from google import genai
from sqlalchemy import text

from blueprints.routines import chat_context as routines_chat_context, routine_names

chat_bp = Blueprint("chat", __name__)

# Nagapandi only ever needs these tables; anything else in generated SQL is refused.
# Routines are personal, so they're never queried directly: Nagapandi is handed
# the asking person's own, worked out (see _routines_rule).
CHAT_BLOCKED = re.compile(
    r"\b(pg_\w*|information_schema|allowed_emails|accounts|budgets|splits|sync_log|routines|routine_\w+)\b",
    re.IGNORECASE,
)
IST = pytz.timezone("Asia/Kolkata")


def _routines_rule(owner):
    """The part of the first prompt that routes routine questions away from SQL."""
    if not owner:
        return ""
    names, first_start = routine_names(owner)
    listed = ", ".join(f'"{n}"' for n in names) if names else "none added yet"
    since = f" Routines began on {first_start}; for activity before then, use physical_activity." if first_start else ""
    return f'''
    ROUTINES: The user also tracks personal routines (habits, challenges and chores with a daily check-in). Theirs: {listed}.
    If the question is about any of these, or about their habits, routines, streaks, challenges, check-ins, chores or consistency,
    do NOT write SQL. Return exactly {{"routines": true}} instead. physical_activity is the older activity log.{since}
    '''


def _validate_generated_sql(sql):
    sql = (sql or "").strip().rstrip(";").strip()
    if not re.match(r"^(select|with)\b", sql, re.IGNORECASE):
        return None, "Nagapandi can only run read-only queries."
    if ";" in sql:
        return None, "Nagapandi can only run a single query."
    if CHAT_BLOCKED.search(sql):
        return None, "Nagapandi can't look at that data."
    return sql, None


def _run_readonly(sql):
    """Run model-written SQL where Postgres itself forbids writes, on its own
    connection so a bad query can never touch the request's session."""
    with db.engine.connect() as conn:
        trans = conn.begin()
        try:
            conn.execute(text("SET TRANSACTION READ ONLY"))
            conn.execute(text("SET LOCAL statement_timeout = '5s'"))
            return conn.execute(text(sql)).fetchall()
        finally:
            trans.rollback()

@chat_bp.route('/api/chat', methods=['POST'])
@require_admin
def handle_chat_query():
    data = request.json
    user_query = data.get('query')
    
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return jsonify({"success": False, "message": "Nagapandi is sleeping (API key missing)."})
        
    client = genai.Client(api_key=api_key)
    model_name = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")

    def generate(prompt_text):
        return client.models.generate_content(model=model_name, contents=prompt_text).text or ""

    owner = (current_access().email or "").strip().lower() or None

    prompt = f'''
    You are 'Nagapandi', a highly capable AI assistant for a personal tracking app (LifeTrack). 
    Your goal is to answer the user's question by generating a PostgreSQL query.
    
    Database Schema:
    - transactions(id, account, date, type, heading, description, amount, exclude_analytics)
    - movie_diary_logs(id, movie_id, date, rating, review, liked, tags, created_at, rewatch)
    - movies(id, tmdb_id, name, poster_path, status, added_on, runtime, release_year)
    - physical_activity(id, date, gym, badminton, table_tennis, cricket, others, description)
    
    IMPORTANT RULES & DOMAIN KNOWLEDGE FOR TRANSACTIONS:
    1. "Spent", "Expense", "Cost", "Paid" means `type = 'Debit'`. "Income" or "Earned" means `type = 'Credit'`.
    2. "Credit Card" means `account ILIKE 'CC-%'`. (e.g. 'CC-AXIS REWARDS', 'CC-PINNACLE 6360').
    3. Today's date is {date.today()}. Use this for resolving "this month" or "this year" (e.g., `extract(month from date) = {date.today().month}`).
    4. If asked about a specific bank (like "Federal", "IDBI", "ICICI"), use `account ILIKE '%bankname%'`.
    5. Categories or High-level groupings are stored in `heading` (e.g., 'Food', 'Snacks', 'Daily Need', 'Transport', 'Cinema', 'Medical').
    6. Specific Merchants, items, or details are stored in `description` (e.g., 'California Burrito', 'Amazon', 'Electricity').
    7. To search for a specific merchant or item (like "california burrito" or "haircut"), use `description ILIKE '%merchant%' OR heading ILIKE '%merchant%'`.
    8. If asked "how much" or "total", return a SUM (`SELECT SUM(amount)`). If asked "how many times", return a COUNT (`SELECT COUNT(*)`). If asked "when was the last", return a MAX date (`SELECT MAX(date)`).
    {_routines_rule(owner)}
    User Query: "{user_query}"
    
    Write a SQL query to fetch the exact data needed to answer the user's question. 
    It MUST start with SELECT and be completely read-only.
    Return ONLY a JSON object exactly like this (without markdown tags):
    {{"sql": "SELECT SUM(amount) FROM transactions WHERE type = 'Debit' AND description ILIKE '%california burrito%' "}}
    '''
    
    try:
        resp_text = generate(prompt).strip()
        if resp_text.startswith('```json'): resp_text = resp_text[7:]
        if resp_text.startswith('```'): resp_text = resp_text[3:]
        if resp_text.endswith('```'): resp_text = resp_text[:-3]
        
        parsed = json.loads(resp_text.strip())
        if parsed.get("routines") and owner:
            context = routines_chat_context(owner, datetime.now(IST).date())
            prompt2 = f'''
        You are 'Nagapandi', a highly capable AI assistant for LifeTrack.
        User asked: "{user_query}"
        Here is everything about the user's routines, already worked out:
        {context}

        Answer based ONLY on this. Be fast, conversational and direct; brief, smooth and friendly.
        Use emojis where appropriate, and cheer genuine progress. Use the percentages and streaks exactly as given.
        Do NOT mention "the data" or how it was given to you.
        '''
            return jsonify({"success": True, "result": generate(prompt2).strip()})

        sql_query = parsed.get("sql")
        
        sql_query, error = _validate_generated_sql(sql_query)
        if error:
            return jsonify({"success": False, "message": error})

        rows = _run_readonly(sql_query)
        db_result = str([dict(row._mapping) for row in rows])[:2000] # Cap size
        
        prompt2 = f'''
        You are 'Nagapandi', a highly capable AI assistant for LifeTrack. 
        User asked: "{user_query}"
        The database returned: {db_result}
        
        Formulate a very fast, conversational, and direct answer based ONLY on the database result. 
        Keep it brief, smooth, and friendly. Use emojis where appropriate. Do NOT mention "the database returned". 
        '''
        final_response = generate(prompt2)
        
        return jsonify({"success": True, "result": final_response.strip()})
        
    except Exception as e:
        print("Nagapandi Error:", e)
        return jsonify({"success": False, "message": f"Nagapandi encountered an error: {str(e)}"})


