"""Push alerts to registered phones (Firebase Cloud Messaging).

Sent as data-only messages: the app builds the notification itself, under the
same id it uses for its own local alert of that kind (low balance, card over
budget), so a transaction added on the phone never alerts twice."""
import threading

from firebase_admin import messaging
from flask import current_app

from extensions import db
from models import DeviceToken


def _rupees(value):
    value = float(value)
    return f"{value:,.0f}" if value == int(value) else f"{value:,.2f}"


def low_balance_message(changes):
    """Title and body for accounts that ended under their floor, or None."""
    below = [c for c in changes if c.get("below_min")]
    if not below:
        return None
    title = (f"{below[0]['account']} is below its minimum" if len(below) == 1
             else f"{len(below)} accounts are below their minimum")
    lines = [f"{c['account']}: ₹{_rupees(c['after'])} left · ₹{_rupees(c['min_balance'] - c['after'])} "
             f"under ₹{_rupees(c['min_balance'])}" for c in below]
    return title, "\n".join(lines)


def card_budget_message(cards):
    """Title and body for credit cards that ended over their monthly budget, or None."""
    over = [c for c in cards if c.get("over_budget")]
    if not over:
        return None
    title = (f"{over[0]['account']} is over its monthly budget" if len(over) == 1
             else f"{len(over)} cards are over their monthly budget")
    lines = [f"{c['account']}: ₹{_rupees(c['after'])} used · ₹{_rupees(c['after'] - c['monthly_budget'])} "
             f"over ₹{_rupees(c['monthly_budget'])}" for c in over]
    return title, "\n".join(lines)


def send_low_balance_alert(changes, owner):
    """Fire-and-forget to the owner's own phones: the request that added the
    transaction doesn't wait on FCM."""
    _push(low_balance_message(changes), "low_balance", owner)


def send_card_budget_alert(cards, owner):
    """Like send_low_balance_alert, for cards that went over their monthly budget."""
    _push(card_budget_message(cards), "card_budget", owner)


def _push(message, kind, owner):
    if not message or not owner:
        return
    tokens = [t.token for t in DeviceToken.query.filter_by(email=owner).all()]
    if not tokens:
        return
    app = current_app._get_current_object()
    threading.Thread(target=_send, args=(app, tokens, kind, *message), daemon=True).start()


def _send(app, tokens, kind, title, body):
    try:
        batch = messaging.MulticastMessage(
            tokens=tokens,
            data={"type": kind, "title": title, "body": body},
            android=messaging.AndroidConfig(priority="high"),
        )
        result = messaging.send_each_for_multicast(batch)
    except Exception as e:
        print(f"⚠️ {kind} push failed: {e}")
        return
    # Phones that uninstalled or rotated their token won't come back; forget them.
    dead = [tokens[i] for i, r in enumerate(result.responses)
            if not r.success and isinstance(r.exception, (messaging.UnregisteredError, messaging.SenderIdMismatchError))]
    if dead:
        with app.app_context():
            DeviceToken.query.filter(DeviceToken.token.in_(dead)).delete(synchronize_session=False)
            db.session.commit()
