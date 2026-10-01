"""Whose data a request touches.

Every personal table carries an owner_email (models.Owned). While a signed-in
request is being served, every ORM query on those tables is limited to that
request's data owner, and every new row is stamped with it, so one person's data
can never reach another's screen. A forgotten filter can't leak: the limit is
applied to every SELECT, UPDATE and DELETE the ORM runs, joins, subqueries and
relationship loads included.

Raw SQL (text()) isn't covered and must filter on owner_email itself.

Outside a request (migrations, scripts, background threads) nothing is limited
and nothing is stamped, so rows created there must set owner_email explicitly.
A request that isn't signed in sees no personal rows at all.
"""
from flask import g, has_request_context
from sqlalchemy import event, literal
from sqlalchemy.orm import Session, with_loader_criteria


def data_owner():
    """The email whose data this request reads and writes, or None."""
    if not has_request_context():
        return None
    return getattr(g, "data_owner", None)


def stamp_owner():
    """Column default for owner_email: the request's data owner, never a guess."""
    owner = data_owner()
    if owner is None:
        raise RuntimeError("Personal rows can only be created for a signed-in person")
    return owner


def install_owner_filter(owned_cls):
    """Limit every ORM statement on owned_cls's subclasses to the data owner.
    Pass execution_options(all_owners=True) for the rare query that must see past
    it (e.g. picking ids that are unique across everyone)."""

    @event.listens_for(Session, "do_orm_execute")
    def _limit_to_owner(state):
        if not has_request_context() or state.execution_options.get("all_owners"):
            return
        if not (state.is_select or state.is_update or state.is_delete):
            return
        owner = getattr(g, "data_owner", None)
        criteria = (lambda cls: cls.owner_email == owner) if owner else (lambda cls: literal(False))
        state.statement = state.statement.options(
            with_loader_criteria(owned_cls, criteria, include_aliases=True))
