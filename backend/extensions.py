"""Shared config, secrets and cross-cutting helpers used by every blueprint."""
from dotenv import load_dotenv
import os
import jwt
import firebase_admin
from firebase_admin import credentials, auth as firebase_auth
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

# Load environment variables from .env.local file (or .env as fallback)
load_dotenv('.env.local')
load_dotenv('.env')

# Initialize Firebase Admin
firebase_cred = credentials.Certificate(os.getenv("FIREBASE_CREDENTIALS_PATH", "firebase-credentials.json"))
firebase_admin.initialize_app(firebase_cred)

ALLOWED_EMAILS = {e.strip().lower() for e in os.getenv("ALLOWED_EMAILS", "").split(",") if e.strip()}

# Permanent super admins. They can never be removed or demoted from the admin UI.
_OWNER_LIST = [e.strip().lower() for e in os.getenv("OWNER_EMAILS", "sbsabarish14@gmail.com").split(",") if e.strip()]
OWNER_EMAILS = set(_OWNER_LIST)
# Whose data scripts using the API key work on: the first owner listed.
PRIMARY_OWNER = _OWNER_LIST[0] if _OWNER_LIST else None

# Load environment variables with validation
API_SECRET_KEY = os.getenv("API_SECRET_KEY")
if not API_SECRET_KEY:
    raise ValueError("API_SECRET_KEY environment variable is required for production")

FLASK_ENV = os.getenv("FLASK_ENV", "development")
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is required")

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",")
SHEETS_URL = os.getenv("SHEETS_URL")
if not SHEETS_URL:
    raise ValueError("SHEETS_URL environment variable is required")

JWT_SECRET = os.getenv("JWT_SECRET")
if not JWT_SECRET:
    raise ValueError("JWT_SECRET environment variable is required")

ADMIN_USER = os.getenv("ADMIN_USER", "admin")
ADMIN_PASS = os.getenv("ADMIN_PASS")
if not ADMIN_PASS:
    raise ValueError("ADMIN_PASS environment variable is required")

# Kite API credentials
KITE_API_KEY = os.getenv("KITE_API_KEY")
KITE_API_SECRET = os.getenv("KITE_API_SECRET")

# TMDB API Key
TMDB_API_KEY = os.getenv("TMDB_API_KEY")
