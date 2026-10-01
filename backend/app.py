from flask import Flask, jsonify
from flask_cors import CORS
import os
import socket
from urllib.parse import urlparse

# extensions.py performs load_dotenv() and firebase_admin.initialize_app() at
# import time (preserving the original module-load-time behavior of app.py).
from extensions import db, ALLOWED_ORIGINS, DATABASE_URL

app = Flask(__name__)

# Money meta and transaction pages are large JSON; gzip them when the client
# accepts it. Optional so a local setup without the package still runs.
try:
    from flask_compress import Compress
    app.config['COMPRESS_MIMETYPES'] = ['application/json', 'text/html', 'text/css', 'application/javascript']
    app.config['COMPRESS_MIN_SIZE'] = 1024
    Compress(app)
except ImportError:
    print("flask-compress not installed; responses go uncompressed")

@app.errorhandler(500)
def internal_error(e):
    return jsonify({"success": False, "message": "Internal server error"}), 500

@app.errorhandler(404)
def not_found(e):
    return jsonify({"success": False, "message": "Not found"}), 404

# Configure CORS with specific origins only
CORS(app, resources={
    r"/api/*": {
        "origins": ALLOWED_ORIGINS,
        "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        "allow_headers": ["Content-Type", "X-API-KEY", "Authorization"],
        "supports_credentials": False,
        "max_age": 3600
    }
})

# Add security headers
@app.after_request
def set_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    response.headers['Content-Security-Policy'] = "default-src 'self'"
    return response

app.config['SQLALCHEMY_DATABASE_URI'] = DATABASE_URL

# Fallback to pg8000 if psycopg2 is missing (e.g. on local Windows Python 3.14)
using_pg8000 = False
try:
    import psycopg2
except ImportError:
    if "postgresql+psycopg2://" in app.config['SQLALCHEMY_DATABASE_URI']:
        app.config['SQLALCHEMY_DATABASE_URI'] = app.config['SQLALCHEMY_DATABASE_URI'].replace("postgresql+psycopg2://", "postgresql+pg8000://")
        using_pg8000 = True

# --- IPv6 Blackhole Fix ---
# Force IPv4 connection to prevent 21s timeout hangs when Windows prefers broken IPv6 routes
if using_pg8000:
    connect_args = {"timeout": 30}
else:
    connect_args = {
        "sslmode": "require",
        "connect_timeout": 30   # Gives Neon 30 seconds to wake up from cold start
    }
    try:
        parsed_url = urlparse(DATABASE_URL)
        if parsed_url.hostname:
            ipv4 = socket.gethostbyname(parsed_url.hostname)
            connect_args["hostaddr"] = ipv4
    except Exception as e:
        print(f"Warning: Could not resolve IPv4 for DB host: {e}")

app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    "pool_pre_ping": True,      # Checks if the DB connection is alive before using it
    "pool_recycle": 300,        # Reconnects every 5 minutes to prevent stale idle connections
    "connect_args": connect_args
}

app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)

# Columns added after the tables existed. Idempotent, so every boot may run it.
with app.app_context():
    from sqlalchemy import text
    try:
        db.session.execute(text("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS min_balance NUMERIC(14,2)"))
        db.session.commit()
        # New tables only (balance_adjustments, device_tokens, routines, routine_checkins);
        # existing ones are left alone.
        import models  # noqa: F401 - registers every table before create_all
        db.create_all()
        # Running balances and account filters walk one person's account history in date order.
        db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_transactions_owner_account_date_id ON transactions (owner_email, account, date, id)"))
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        print(f"⚠️ Could not ensure money schema: {e}")
    finally:
        # gunicorn --preload forks the workers after this ran: they must not
        # inherit this process's open connections, or they'd share sockets.
        db.session.remove()
        db.engine.dispose()

from blueprints.core import core_bp
from blueprints.money import money_bp
from blueprints.money_query import money_query_bp
from blueprints.activities import activities_bp
from blueprints.invest import invest_bp
from blueprints.auth import auth_bp
from blueprints.admin import admin_bp
from blueprints.media import media_bp
from blueprints.chat import chat_bp
from blueprints.routines import routines_bp

app.register_blueprint(core_bp)
app.register_blueprint(money_bp)
app.register_blueprint(money_query_bp)
app.register_blueprint(activities_bp)
app.register_blueprint(invest_bp)
app.register_blueprint(auth_bp)
app.register_blueprint(admin_bp)
app.register_blueprint(media_bp)
app.register_blueprint(chat_bp)
app.register_blueprint(routines_bp)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)

# Trigger HF sync
