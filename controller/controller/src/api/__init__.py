"""API routes"""
from .routes_navigation import router as navigation_router
from .routes_events import router as events_router
from .routes_patrol import router as patrol_router
from .routes_poi import router as poi_router

__all__ = ["navigation_router", "events_router", "patrol_router", "poi_router"]
