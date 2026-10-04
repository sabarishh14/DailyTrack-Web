"""SQLAlchemy models, shared by all blueprints."""
from datetime import datetime, date
from extensions import db
from tenancy import stamp_owner, install_owner_filter

# Rupees stored exactly to the paisa. Python still sees floats, so JSON stays numeric.
Money = db.Numeric(14, 2, asdecimal=False)
# BIGINT (BIGSERIAL when the database numbers it) on Postgres; SQLite (the API
# tests) only auto-numbers INTEGER keys.
BigId = db.BigInteger().with_variant(db.Integer, "sqlite")


class Owned:
    """Belongs to one person. Queries only ever see the signed-in person's rows,
    and new rows are stamped with them (tenancy.py)."""
    owner_email = db.Column(db.String(120), nullable=False, index=True, default=stamp_owner)


class Account(Owned, db.Model):
    __tablename__ = "accounts"
    # Names are per person: two people can both have a KOTAK.
    __table_args__ = (db.PrimaryKeyConstraint("owner_email", "account"),)
    account = db.Column(db.String(50), nullable=False)
    balance = db.Column(Money, default=0)
    real_balance = db.Column(Money, nullable=True)
    balance_tracked = db.Column(db.Boolean, default=True)
    # Warn when a transaction would take the balance below this. None = no floor.
    min_balance = db.Column(Money, nullable=True)
    # A credit card's spending limit for each calendar month. None = no limit.
    monthly_budget = db.Column(Money, nullable=True)
class Transaction(Owned, db.Model):
    __tablename__ = "transactions"
    # Identical spends on one day are fine (two ₹90 snacks), so there's no
    # uniqueness rule beyond the id.
    __table_args__ = (
        db.ForeignKeyConstraint(['owner_email', 'account'], ['accounts.owner_email', 'accounts.account'],
                                name='fk_transactions_account'),
    )
    id = db.Column(BigId, primary_key=True)
    account = db.Column(db.String(50))
    date = db.Column(db.Date, nullable=False, index=True) # <-- Added index for faster sorting
    month = db.Column(db.Date, nullable=False, index=True) # <-- Added index for faster filtering
    type = db.Column(db.String(10), nullable=False)
    heading = db.Column(db.String(100), nullable=False)
    description = db.Column(db.String(255))
    amount = db.Column(Money, nullable=False)
    synced = db.Column(db.Boolean, default=False)
    exclude_analytics = db.Column(db.Boolean, default=False)
class Split(Owned, db.Model):
    __tablename__ = "splits"
    id = db.Column(BigId, primary_key=True)
    transaction_id = db.Column(db.BigInteger, db.ForeignKey('transactions.id'), unique=True, nullable=False)
    total_amount = db.Column(Money, nullable=False)
    members = db.Column(db.JSON, nullable=False, default=list)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
class RecurringTask(Owned, db.Model):
    __tablename__ = "recurring_tasks"
    id = db.Column(BigId, primary_key=True)
    asset_name = db.Column(db.String(100)) # e.g., 'EPF'
    amount_to_add = db.Column(db.Float)    # e.g., 2210
    interval_value = db.Column(db.Integer, default=1)
    interval_unit = db.Column(db.String(10), default='months') # 'days', 'months', 'years'
    next_run_date = db.Column(db.Date)
    is_active = db.Column(db.Boolean, default=True)
class EquityHolding(Owned, db.Model):
    __tablename__ = "equity_holdings"

    id = db.Column(BigId, primary_key=True)
    date = db.Column(db.Date, nullable=False, index=True)
    symbol = db.Column(db.String(100), nullable=False)
    quantity = db.Column(db.Float, nullable=False)
    average_price = db.Column(db.Float, nullable=False)
    ltp = db.Column(db.Float, nullable=False)
    invested_value = db.Column(db.Float, nullable=False)
    current_value = db.Column(db.Float, nullable=False)
class PhysicalActivity(Owned, db.Model):
    __tablename__ = "physical_activity"
    __table_args__ = (db.UniqueConstraint("owner_email", "date", name="uq_physical_activity_owner_date"),)

    id = db.Column(BigId, primary_key=True)
    date = db.Column(db.Date, nullable=False)
    gym = db.Column(db.Boolean, default=False)
    badminton = db.Column(db.Boolean, default=False)
    table_tennis = db.Column(db.Boolean, default=False)
    cricket = db.Column(db.Boolean, default=False)
    others = db.Column(db.Boolean, default=False)
    description = db.Column(db.String(255))
class MutualFundHolding(Owned, db.Model):
    __tablename__ = "mf_holdings"

    id = db.Column(BigId, primary_key=True)
    date = db.Column(db.Date, nullable=False, index=True)
    symbol = db.Column(db.String(100), nullable=False)
    quantity = db.Column(db.Float, nullable=False)
    average_price = db.Column(db.Float, nullable=False)
    nav = db.Column(db.Float, nullable=False)
    invested_value = db.Column(db.Float, nullable=False)
    current_value = db.Column(db.Float, nullable=False)
class ManualAsset(Owned, db.Model):
    __tablename__ = "manual_assets"

    id = db.Column(BigId, primary_key=True)
    category = db.Column(db.String(50), nullable=False) # FD, EPF, PPF, NPS, SGB, RSU, RealEstate, Cash
    name = db.Column(db.String(100), nullable=False)
    invested_value = db.Column(db.Float, default=0.0)
    current_value = db.Column(db.Float, default=0.0)
    interest_rate = db.Column(db.Float, nullable=True)
    start_date = db.Column(db.Date, nullable=True) # <-- ADD THIS LINE
    maturity_date = db.Column(db.Date, nullable=True)
    last_updated = db.Column(db.Date, nullable=False)
class PortfolioSnapshot(Owned, db.Model):
    __tablename__ = "portfolio_snapshots"

    id = db.Column(BigId, primary_key=True)
    date = db.Column(db.Date, nullable=False, index=True)
    
    total_equity_inv = db.Column(db.Float, default=0.0)
    total_equity_curr = db.Column(db.Float, default=0.0)
    
    total_mf_inv = db.Column(db.Float, default=0.0)
    total_mf_curr = db.Column(db.Float, default=0.0)
    
    total_fixed_income_inv = db.Column(db.Float, default=0.0)
    total_fixed_income_curr = db.Column(db.Float, default=0.0)
    
    total_provident_inv = db.Column(db.Float, default=0.0)
    total_provident_curr = db.Column(db.Float, default=0.0)
    
    total_gold_inv = db.Column(db.Float, default=0.0)
    total_gold_curr = db.Column(db.Float, default=0.0)
    
    grand_total_inv = db.Column(db.Float, default=0.0)
    grand_total_curr = db.Column(db.Float, default=0.0)
    
    synced = db.Column(db.Boolean, default=False)
class SyncLog(db.Model):
    __tablename__ = "sync_log"
    id = db.Column(BigId, primary_key=True)
    last_sync = db.Column(db.DateTime, nullable=False)

# ADD THIS NEW MODEL BELOW:
class AllowedEmail(db.Model):
    __tablename__ = "allowed_emails"
    email = db.Column(db.String(120), primary_key=True)
    added_on = db.Column(db.DateTime, default=datetime.utcnow)
    # Access control (see ACCESS_CONTROL.md). role NULL = pre-RBAC guest with full access.
    role = db.Column(db.String(20), nullable=True)          # admin | member
    permissions = db.Column(db.JSON, nullable=True)         # {"modules": {...}, "money_scope": {...}}
    updated_on = db.Column(db.DateTime, nullable=True)
class TvShow(Owned, db.Model):
    __tablename__ = "tv_shows"
    __table_args__ = (db.UniqueConstraint("owner_email", "tmdb_id", name="uq_tv_shows_owner_tmdb"),)
    id = db.Column(BigId, primary_key=True)
    tmdb_id = db.Column(db.Integer, nullable=False)
    name = db.Column(db.String(255), nullable=False)
    poster_path = db.Column(db.String(255))
    status = db.Column(db.String(50), default="TO WATCH") # WATCHING, WATCHED, TO WATCH, DROPPED
    watched_episodes = db.Column(db.JSON, default=dict) # e.g. {"1": [1, 2, 3]} mapping season string to array of episode numbers
    language = db.Column(db.String(10), nullable=True) # ISO 639-1 original language, fetched from TMDB
    added_on = db.Column(db.DateTime, default=datetime.utcnow)
class TvDiaryLog(Owned, db.Model):
    __tablename__ = "tv_diary_logs"
    id = db.Column(BigId, primary_key=True)
    tv_show_id = db.Column(db.BigInteger, db.ForeignKey("tv_shows.id"), nullable=False)
    season_number = db.Column(db.Integer, nullable=True) # Null if logging the whole show
    episode_number = db.Column(db.Integer, nullable=True) # Null if logging the whole show
    date = db.Column(db.Date, nullable=False, default=date.today)
    rating = db.Column(db.Float, nullable=True) # 1-5 stars
    review = db.Column(db.Text, nullable=True)
    liked = db.Column(db.Boolean, default=False)
    rewatch = db.Column(db.Boolean, default=False)
    tags = db.Column(db.String(500), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    # Relationship to TvShow
    tv_show = db.relationship('TvShow', backref=db.backref('diary_logs', lazy=True, cascade="all, delete-orphan"))
class TvActivityLog(Owned, db.Model):
    __tablename__ = "tv_activity_logs"
    id = db.Column(BigId, primary_key=True)
    tv_show_id = db.Column(db.BigInteger, db.ForeignKey("tv_shows.id"), nullable=False)
    action = db.Column(db.String(255), nullable=False) # e.g. "Added to library", "Status changed to WATCHED"
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    tv_show = db.relationship('TvShow', backref=db.backref('activity_logs', lazy=True, cascade="all, delete-orphan"))
class Movie(Owned, db.Model):
    __tablename__ = "movies"
    __table_args__ = (db.UniqueConstraint("owner_email", "tmdb_id", name="uq_movies_owner_tmdb"),)
    id = db.Column(BigId, primary_key=True)
    tmdb_id = db.Column(db.Integer, nullable=False)
    name = db.Column(db.String(255), nullable=False)
    poster_path = db.Column(db.String(255))
    status = db.Column(db.String(50), default="TO WATCH") # WATCHED, TO WATCH
    runtime = db.Column(db.Integer, nullable=True)  # Runtime in minutes, fetched from TMDB
    release_year = db.Column(db.Integer, nullable=True) # Release year of the movie
    release_date = db.Column(db.String(20), nullable=True) # e.g. "YYYY-MM-DD"
    director = db.Column(db.String(255), nullable=True)
    top_cast = db.Column(db.JSON, nullable=True)
    language = db.Column(db.String(10), nullable=True) # ISO 639-1 original language, fetched from TMDB
    added_on = db.Column(db.DateTime, default=datetime.utcnow)
class MovieDiaryLog(Owned, db.Model):
    __tablename__ = "movie_diary_logs"
    id = db.Column(BigId, primary_key=True)
    movie_id = db.Column(db.BigInteger, db.ForeignKey("movies.id"), nullable=False)
    date = db.Column(db.Date, nullable=False, default=date.today)
    rating = db.Column(db.Float, nullable=True) # 1-5 stars
    review = db.Column(db.Text, nullable=True)
    liked = db.Column(db.Boolean, default=False)
    rewatch = db.Column(db.Boolean, default=False)
    tags = db.Column(db.String(500), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    # Relationship to Movie
    movie = db.relationship('Movie', backref=db.backref('diary_logs', lazy=True, cascade="all, delete-orphan"))
class Budget(Owned, db.Model):
    __tablename__ = "budgets"
    __table_args__ = (db.UniqueConstraint("owner_email", "category", name="uq_budgets_owner_category"),)
    id = db.Column(BigId, primary_key=True)
    category = db.Column(db.String(100), nullable=False)
    monthly_limit = db.Column(Money, nullable=False)
class BalanceAdjustment(Owned, db.Model):
    """A balance set by hand (override, Sheet sync) rather than by a transaction.
    Kept so the running-balance column can account for the jump."""
    __tablename__ = "balance_adjustments"
    __table_args__ = (
        db.ForeignKeyConstraint(['owner_email', 'account'], ['accounts.owner_email', 'accounts.account'],
                                name='fk_balance_adjustments_account'),
    )
    # Epoch ms when it was made, the same scale as transaction ids, so both sort
    # into one ledger by (date, id).
    id = db.Column(BigId, primary_key=True)
    account = db.Column(db.String(50), nullable=False, index=True)
    date = db.Column(db.Date, nullable=False)
    delta = db.Column(Money, nullable=False)
    reason = db.Column(db.String(40))
class Share(db.Model):
    """owner_email lets viewer_email see some of their data, read-only.
    modules: the ones shared, e.g. ["money", "invest"]."""
    __tablename__ = "shares"
    owner_email = db.Column(db.String(120), primary_key=True)
    viewer_email = db.Column(db.String(120), primary_key=True, index=True)
    modules = db.Column(db.JSON, nullable=False, default=list)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
class AccessRequest(db.Model):
    """Someone not yet allowed tried to sign in; an admin approves or declines."""
    __tablename__ = "access_requests"
    email = db.Column(db.String(120), primary_key=True)
    name = db.Column(db.String(120))
    requested_at = db.Column(db.DateTime, default=datetime.utcnow)
class UserSettings(db.Model):
    """One person's preferences that follow them across devices."""
    __tablename__ = "user_settings"
    email = db.Column(db.String(120), primary_key=True)
    letterboxd_username = db.Column(db.String(60))
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
class DeviceToken(db.Model):
    """A phone that wants push alerts (low balance), per signed-in user."""
    __tablename__ = "device_tokens"
    token = db.Column(db.String(255), primary_key=True)
    email = db.Column(db.String(120), nullable=False, index=True)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow)
class Routine(db.Model):
    """A habit, challenge or recurring chore on the Routines page. Personal:
    every query is scoped to owner_email. What's due when, streaks and scores are
    worked out on the phone from these rows and their check-ins."""
    __tablename__ = "routines"
    # BIGSERIAL on Postgres; SQLite (the API tests) only auto-numbers INTEGER keys.
    id = db.Column(db.BigInteger().with_variant(db.Integer, "sqlite"), primary_key=True)
    owner_email = db.Column(db.String(120), nullable=False, index=True)
    name = db.Column(db.String(60), nullable=False)
    emoji = db.Column(db.String(16))
    kind = db.Column(db.String(8), nullable=False, default="build")       # build | avoid
    schedule = db.Column(db.String(10), nullable=False, default="daily")  # daily | days | weekly | monthly | interval
    days = db.Column(db.SmallInteger)       # "days": weekday bitmask, Mon=1 … Sun=64
    target = db.Column(db.SmallInteger)     # "weekly" / "monthly": times per period
    every = db.Column(db.SmallInteger)      # "interval": every N …
    unit = db.Column(db.String(6))          # … day | week | month
    # First day it counts; for "interval", the first due date.
    start_date = db.Column(db.Date, nullable=False)
    end_date = db.Column(db.Date)           # a challenge's last day, inclusive
    sort_order = db.Column(db.Integer, nullable=False, default=0)
    archived = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
class RoutineCheckIn(db.Model):
    """One day's answer for a routine: done, missed or skipped (a genuine reason)."""
    __tablename__ = "routine_checkins"
    __table_args__ = (db.UniqueConstraint("routine_id", "date", name="uq_routine_checkin_day"),)
    id = db.Column(db.BigInteger().with_variant(db.Integer, "sqlite"), primary_key=True)
    routine_id = db.Column(db.BigInteger, db.ForeignKey("routines.id", ondelete="CASCADE"), nullable=False)
    date = db.Column(db.Date, nullable=False)
    status = db.Column(db.String(8), nullable=False)  # done | missed | skipped
    note = db.Column(db.String(120))
    updated_at = db.Column(db.DateTime, default=datetime.utcnow)


# Every query on an Owned table is limited to the signed-in person (tenancy.py).
install_owner_filter(Owned)
