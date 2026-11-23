"""Constants for Comfort Schedule."""

DOMAIN = "comfort_schedule"
VERSION = "0.0.2"

STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1

CARD_FILENAME = "comfort-schedule-card.js"
CARD_URL = f"/{DOMAIN}/{CARD_FILENAME}"

NO_PROFILE = "No profile"

# Time, sun and template conditions can change without any entity changing.
REEVALUATE_SECONDS = 30
