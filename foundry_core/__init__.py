"""Foundry core: the shared reducer, the fixture state machine and the live kanban source.

Pure Python with no Hermes imports at module level, so the reducer and the fixture are
testable (and runnable with no model calls or credentials) outside a Hermes install.
"""

SCHEMA_VERSION = 1
