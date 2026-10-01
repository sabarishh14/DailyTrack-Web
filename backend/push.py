"""Push alerts to registered phones (Firebase Cloud Messaging).

Sent as data-only messages: the app builds the notification itself, under the
same id it uses for its own local low-balance alert, so a transaction added on
the phone never alerts twice."""
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


def send_low_balance_alert(changes, owner):
    """Fire-and-forget to the owner's own phones: the request that added the
    transaction doesn't wait on FCM."""
    message = low_balance_message(changes)
    if not message or not owner:
        return
    tokens = [t.token for t in DeviceToken.query.filter_by(email=owner).all()]
    if not tokens:
        return
    app = current_app._get_current_object()
    threading.Thread(target=_send, args=(app, tokens, *message), daemon=True).start()


def _send(app, tokens, title, body):
    try:
        batch = messaging.MulticastMessage(
            tokens=tokens,
            data={"type": "low_balance", "title": title, "body": body},
            android=messaging.AndroidConfig(priority="high"),
        )
        result = messaging.send_each_for_multicast(batch)
    except Exception as e:
        print(f"⚠️ Low-balance push failed: {e}")
        return
    # Phones that uninstalled or rotated their token won't come back; forget them.
    dead = [tokens[i] for i, r in enumerate(result.responses)
            if not r.success and isinstance(r.exception, (messaging.UnregisteredError, messaging.SenderIdMismatchError))]
    if dead:
        with app.app_context():
            DeviceToken.query.filter(DeviceToken.token.in_(dead)).delete(synchronize_session=False)
            db.session.commit()
