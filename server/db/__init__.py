"""
The database, as one import.

`from db import db, init, dialect, describe` is the whole surface. Everything
that knows which backend is live is in `driver.py`; everything that knows how
the two dialects differ is in `sqlrewrite.py`; the schema is in `schema.py`.
Nothing else in the server has to care.
"""

from .driver import connect as db
from .driver import describe, dialect
from .schema import init

__all__ = ["db", "describe", "dialect", "init"]
