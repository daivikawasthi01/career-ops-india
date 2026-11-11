

# Tests run against fixture details, never the facts.yml or config.local.yaml of whoever runs them.
from pathlib import Path as _Path

from lib import config as _config, profile as _profile

_FIXTURES = _Path(__file__).parent / "fixtures"
_real_path = _config.path


_FIXED = {("facts", "paths_extra"): "facts.yml", ("cv", "paths_extra"): "cv.md", ("profile", "paths"): "profile.yml"}


def _fixture_path(key, section="paths"):
    name = _FIXED.get((key, section))
    return _FIXTURES / name if name else _real_path(key, section)


_config.path = _fixture_path
_config.LOCAL = _FIXTURES / "local-settings.yaml"
from lib import style as _style
_style.DIR = _FIXTURES / "no-style"   # nobody's real samples in a test
_config.load.cache_clear()
_profile.reload()
