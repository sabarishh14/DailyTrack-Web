"""One-off: give every personal row an owner, so each person has their own data.

    python migrate_multi_user.py --owner you@gmail.com             # report only, changes nothing
    python migrate_multi_user.py --owner you@gmail.com --apply     # migrate, in one transaction
    python migrate_multi_user.py --owner you@gmail.com --apply --letterboxd yourname
    python migrate_multi_user.py --owner you@gmail.com --finalize  # once the new code is live

Everything that exists today becomes the owner's. Run it before deploying the
code that expects owner_email, after taking a Neon branch as a backup. It's safe
to run again: finished steps are skipped.

Until the new code is live, owner_email defaults to the owner so the old code can
keep adding rows; --finalize removes that default.

What changes:
  - owner_email on every personal table (backfilled to the owner, indexed)
  - accounts are keyed by (owner_email, account), so names are per person, and
    transactions / balance adjustments point at an account of the same person
  - rules that were unique across everyone (budget categories, TMDB ids, gym
    days) become unique per person, where the database has them; nothing that's
    allowed today starts being refused (identical spends on one day stay fine)
  - data the new links can't hold yet (a transaction naming an account that
    doesn't exist) is reported and left as it is, never fatal
  - user_settings, for each person's Letterboxd username
"""
import argparse
import os
import re
import sys
from urllib.parse import urlparse, parse_qs

import pg8000.dbapi as pg
from dotenv import load_dotenv

OWNED_TABLES = [
    "accounts", "transactions", "splits", "balance_adjustments", "budgets",
    "recurring_tasks", "manual_assets", "equity_holdings", "mf_holdings", "portfolio_snapshots",
    "physical_activity", "tv_shows", "tv_diary_logs", "tv_activity_logs", "movies", "movie_diary_logs",
]
# Tables whose rows point at an account by name.
ACCOUNT_CHILDREN = {"transactions": "fk_transactions_account",
                    "balance_adjustments": "fk_balance_adjustments_account"}
# Uniqueness that held across everyone becomes per person: (table, its columns,
# the per-person rule's name). Only a rule the database actually has is moved, so
# nothing that's allowed today starts being refused. Transactions' old rule is
# dropped, not moved: identical spends on one day are fine.
PER_PERSON_UNIQUE = [
    ("transactions", ["date", "account", "amount", "heading"], None),
    ("budgets", ["category"], "uq_budgets_owner_category"),
    ("tv_shows", ["tmdb_id"], "uq_tv_shows_owner_tmdb"),
    ("movies", ["tmdb_id"], "uq_movies_owner_tmdb"),
    ("physical_activity", ["date"], "uq_physical_activity_owner_date"),
]
EMAIL = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
LETTERBOXD = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def connect():
    load_dotenv(".env.local")
    load_dotenv(".env")
    raw = os.environ["DATABASE_URL"].replace("postgresql+psycopg2://", "postgresql://").replace("postgresql+pg8000://", "postgresql://")
    url = urlparse(raw)
    ssl = parse_qs(url.query).get("sslmode", ["require"])[0] != "disable"
    return pg.connect(user=url.username, password=url.password, host=url.hostname,
                      port=url.port or 5432, database=url.path.lstrip("/"), ssl_context=True if ssl else None)


class Migration:
    def __init__(self, cur, owner):
        self.cur = cur
        self.owner = owner
        self.steps = []          # (description, sql, params)
        self.warnings = []       # data that needs a look; reported, never fatal

    # ---- schema lookups ----
    def one(self, sql, params=()):
        self.cur.execute(sql, params)
        return self.cur.fetchone()

    def all(self, sql, params=()):
        self.cur.execute(sql, params)
        return self.cur.fetchall()

    def table_exists(self, table):
        return self.one("SELECT to_regclass(%s) IS NOT NULL", (f"public.{table}",))[0]

    def exists(self, name):
        return self.one("SELECT to_regclass(%s) IS NOT NULL", (f"public.{name}",))[0]

    def has_column(self, table, column):
        return self.one("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' "
                        "AND table_name = %s AND column_name = %s", (table, column)) is not None

    def constraints(self, table, kind):
        """{name: [columns]} of one kind: 'p' primary key, 'u' unique, 'f' foreign key."""
        rows = self.all("""
            SELECT con.conname, array_agg(att.attname::text ORDER BY k.ord)
            FROM pg_constraint con
            CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
            WHERE con.conrelid = %s::regclass AND con.contype = %s
            GROUP BY con.conname""", (f"public.{table}", kind))
        return {name: list(cols) for name, cols in rows}

    def unique_indexes(self, table):
        """{name: [columns]} of unique indexes that don't belong to a constraint."""
        rows = self.all("""
            SELECT i.relname, array_agg(a.attname::text ORDER BY k.ord)
            FROM pg_index x
            JOIN pg_class i ON i.oid = x.indexrelid
            CROSS JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
            WHERE x.indrelid = %s::regclass AND x.indisunique AND NOT x.indisprimary
              AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)
            GROUP BY i.relname""", (f"public.{table}",))
        return {name: list(cols) for name, cols in rows}

    def foreign_keys_to(self, table):
        """[(child table, constraint, [columns])] of foreign keys pointing at table."""
        rows = self.all("""
            SELECT rel.relname, con.conname, array_agg(att.attname::text ORDER BY k.ord)
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
            WHERE con.confrelid = %s::regclass AND con.contype = 'f'
            GROUP BY rel.relname, con.conname""", (f"public.{table}",))
        return [(child, name, list(cols)) for child, name, cols in rows]

    def orphans(self, child):
        """[(account, rows)] of child rows naming an account that doesn't exist."""
        same_person = (" AND a.owner_email = c.owner_email"
                       if self.has_column(child, "owner_email") and self.has_column("accounts", "owner_email") else "")
        return self.all(f"""
            SELECT c.account, count(*) FROM {child} c
            WHERE c.account IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.account = c.account{same_person})
            GROUP BY c.account ORDER BY c.account""")

    def add(self, description, sql, params=()):
        self.steps.append((description, sql, params))

    # ---- the plan ----
    def plan(self):
        owner_literal = "'" + self.owner + "'"   # validated email: no quotes possible
        tables = [t for t in OWNED_TABLES if self.table_exists(t)]
        for missing in sorted(set(OWNED_TABLES) - set(tables)):
            print(f"  {missing}: table missing, skipped")

        for t in tables:
            if not self.has_column(t, "owner_email"):
                self.add(f"{t}: add owner_email", f"ALTER TABLE {t} ADD COLUMN owner_email VARCHAR(120)")
                self.add(f"{t}: every row becomes the owner's", f"UPDATE {t} SET owner_email = %s", (self.owner,))
                self.add(f"{t}: owner_email required", f"ALTER TABLE {t} ALTER COLUMN owner_email SET NOT NULL")
                self.add(f"{t}: old code's rows default to the owner",
                         f"ALTER TABLE {t} ALTER COLUMN owner_email SET DEFAULT {owner_literal}")
            else:
                nulls = self.one(f"SELECT count(*) FROM {t} WHERE owner_email IS NULL")[0]
                if nulls:
                    self.add(f"{t}: {nulls} row(s) without an owner become the owner's",
                             f"UPDATE {t} SET owner_email = %s WHERE owner_email IS NULL", (self.owner,))
            if not self.exists(f"ix_{t}_owner_email"):
                self.add(f"{t}: index owner_email", f"CREATE INDEX ix_{t}_owner_email ON {t} (owner_email)")

        # Accounts keyed per person; children point at the same person's account.
        if "accounts" in tables:
            pk = self.constraints("accounts", "p")
            if list(pk.values()) != [["owner_email", "account"]]:
                # Anything pointing at an account by name alone has to let go first.
                for child, name, cols in self.foreign_keys_to("accounts"):
                    if cols != ["owner_email", "account"]:
                        self.add(f"{child}: drop {name} (account by name only)",
                                 f"ALTER TABLE {child} DROP CONSTRAINT {name}")
                for name in pk:
                    self.add(f"accounts: drop primary key {name}", f"ALTER TABLE accounts DROP CONSTRAINT {name}")
                self.add("accounts: key by (owner_email, account)",
                         "ALTER TABLE accounts ADD CONSTRAINT accounts_pkey PRIMARY KEY (owner_email, account)")
            for child, fk_name in ACCOUNT_CHILDREN.items():
                if child not in tables or fk_name in self.constraints(child, "f"):
                    continue
                missing = self.orphans(child)
                if missing:
                    listed = ", ".join(f"{name} ({count})" for name, count in missing[:10])
                    self.warnings.append(
                        f"{child}: {sum(count for _, count in missing)} row(s) name accounts that don't exist: "
                        f"{listed}. Left unlinked for now; add those accounts and run this again to link them.")
                    continue
                self.add(f"{child}: account must be the same person's",
                         f"ALTER TABLE {child} ADD CONSTRAINT {fk_name} FOREIGN KEY (owner_email, account) "
                         f"REFERENCES accounts (owner_email, account)")

        # Uniqueness that held across everyone holds per person instead.
        for table, old_cols, new_name in PER_PERSON_UNIQUE:
            if table not in tables:
                continue
            old_rules = [(name, f"ALTER TABLE {table} DROP CONSTRAINT {name}")
                         for name, cols in self.constraints(table, "u").items() if cols == old_cols]
            old_rules += [(name, f"DROP INDEX {name}")
                          for name, cols in self.unique_indexes(table).items() if cols == old_cols]
            for name, sql in old_rules:
                self.add(f"{table}: drop {name} (unique across everyone)", sql)
            if old_rules and new_name:
                self.add(f"{table}: unique per person on ({', '.join(old_cols)})",
                         f"ALTER TABLE {table} ADD CONSTRAINT {new_name} UNIQUE (owner_email, {', '.join(old_cols)})")

        if "transactions" in tables:
            if not self.exists("ix_transactions_owner_account_date_id"):
                self.add("transactions: index for one person's account history",
                         "CREATE INDEX ix_transactions_owner_account_date_id "
                         "ON transactions (owner_email, account, date, id)")
            if self.exists("ix_transactions_account_date_id"):
                self.add("transactions: drop the old all-accounts history index",
                         "DROP INDEX ix_transactions_account_date_id")

        if not self.table_exists("user_settings"):
            self.add("user_settings: each person's own settings",
                     "CREATE TABLE user_settings (email VARCHAR(120) PRIMARY KEY, "
                     "letterboxd_username VARCHAR(60), updated_at TIMESTAMP)")

    def plan_letterboxd(self, username):
        self.add(f"user_settings: the owner's Letterboxd is {username}",
                 "INSERT INTO user_settings (email, letterboxd_username, updated_at) VALUES (%s, %s, now()) "
                 "ON CONFLICT (email) DO UPDATE SET letterboxd_username = EXCLUDED.letterboxd_username, updated_at = now()",
                 (self.owner, username))

    def plan_finalize(self):
        for t in OWNED_TABLES:
            has_default = self.one("SELECT column_default IS NOT NULL FROM information_schema.columns "
                                   "WHERE table_schema = 'public' AND table_name = %s AND column_name = 'owner_email'", (t,))
            if has_default and has_default[0]:
                self.add(f"{t}: no default owner any more", f"ALTER TABLE {t} ALTER COLUMN owner_email DROP DEFAULT")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--owner", required=True, help="the owner's Google email; today's data becomes theirs")
    parser.add_argument("--apply", action="store_true", help="make the changes (default: report only)")
    parser.add_argument("--letterboxd", help="the owner's Letterboxd username")
    parser.add_argument("--finalize", action="store_true", help="drop the transition default, once the new code is live")
    args = parser.parse_args()

    owner = args.owner.strip().lower()
    if not EMAIL.match(owner):
        print(f"{args.owner!r} isn't an email address")
        return 2
    if args.letterboxd and not LETTERBOXD.match(args.letterboxd):
        print(f"{args.letterboxd!r} isn't a Letterboxd username")
        return 2

    conn = connect()
    cur = conn.cursor()
    migration = Migration(cur, owner)

    print(f"Owner: {owner}\n")
    for t in OWNED_TABLES:
        if migration.table_exists(t):
            print(f"  {t}: {migration.one(f'SELECT count(*) FROM {t}')[0]} row(s)")
    print()

    if args.finalize:
        migration.plan_finalize()
    else:
        migration.plan()
        if args.letterboxd:
            migration.plan_letterboxd(args.letterboxd)

    for description, _, _ in migration.steps:
        print(f"  - {description}")
    for warning in migration.warnings:
        print(f"  ! {warning}")
    if not migration.steps:
        print("Nothing to do.")
        return 0
    if not (args.apply or args.finalize):
        print("\nReport only. Re-run with --apply to migrate.")
        return 0

    try:
        for description, sql, params in migration.steps:
            cur.execute(sql, params)
        conn.commit()
    except Exception as e:
        conn.rollback()
        print(f"\nFailed, nothing was changed: {e}")
        return 1
    print(f"\nDone: {len(migration.steps)} step(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
