#!/usr/bin/env python3
"""Markdown inventory of every Python distribution installed in the running interpreter.

Run with the Python that is bundled in an installer (desktop/scripts/stage.mjs does this at build
time) so the list matches exactly what is distributed: name, version, declared license and where
its license text is inside the package.

usage: python third_party_inventory.py <output.md> [site-packages directory]
(the directory lets a Linux build list the packages staged for Windows)
"""

import importlib.metadata as metadata
import platform
import sys
from pathlib import Path

LICENSE_WORDS = ('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'AUTHORS')
# Wheels that ship no license text: AstroviaBin provides it in licenses/third-party/.
PROVIDED = {'astroalign': 'licenses/third-party/astroalign-LICENSE.txt', 'pims': 'licenses/third-party/PIMS-LICENSE.txt',
            'sep': 'licenses/third-party/sep/ and licenses/third-party/gnu/ (LGPL-3.0, GPL-3.0); source in licenses/sources/'}


def declared_license(meta) -> str:
    expression = (meta.get('License-Expression') or '').strip()
    if expression:
        return expression
    classifiers = [item.split('::')[-1].strip() for item in (meta.get_all('Classifier') or []) if item.startswith('License ::')]
    if classifiers:
        return ' / '.join(dict.fromkeys(classifiers))
    text = (meta.get('License') or '').strip().splitlines()
    return text[0][:80] if text else 'see license file'


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print(__doc__, file=sys.stderr)
        return 2
    rows = {}
    search = {'path': [sys.argv[2]]} if len(sys.argv) == 3 else {}
    for distribution in metadata.distributions(**search):
        meta = distribution.metadata
        name = meta['Name']
        if not name or name.lower() in rows:
            continue
        files = [str(item) for item in (distribution.files or []) if any(word in str(item).upper() for word in LICENSE_WORDS)]
        where = PROVIDED.get(name.lower()) if name.lower() == 'sep' else (', '.join(sorted(files)[:3]) or PROVIDED.get(name.lower(), 'none in the wheel'))
        home = meta.get('Home-page') or next((url.split(',', 1)[-1].strip() for url in (meta.get_all('Project-URL') or [])), '')
        rows[name.lower()] = (name, meta['Version'], declared_license(meta), where, home)
    lines = [
        '# Bundled Python packages',
        '',
        f'Generated from the bundled packages ({"Windows installer" if len(sys.argv) == 3 else f"Python {platform.python_version()}, {sys.platform}"}) by '
        '`tools/scripts/third_party_inventory.py`. Every package is distributed unmodified; its license text '
        'is installed with it (the path is relative to the `site-packages` folder) or provided by AstroviaBin.',
        '',
        '| Package | Version | License | License text | Project |',
        '|---|---|---|---|---|',
    ]
    for _, (name, version, license_name, where, home) in sorted(rows.items()):
        lines.append(f'| {name} | {version} | {license_name.replace("|", "/")} | {where} | {home} |')
    lines.append('')
    Path(sys.argv[1]).write_text('\n'.join(lines), encoding='utf-8')
    print(f'{len(rows)} distributions written to {sys.argv[1]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
