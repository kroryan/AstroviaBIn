#!/bin/sh
# Downloads extra Astrometry.net 2MASS index files for narrow fields of view into a persistent
# directory (default: /app/config/astrometry-index, i.e. AppData/astrometry-index on the host).
# The image ships index-4208..4219 (fields of roughly 30' and wider). Add smaller scales for
# longer focal lengths:
#   4207 ≈ 22-30' quads (12 files, ~0.2 GB)   4206 ≈ 16-22' (12, ~0.3 GB)
#   4205 ≈ 11-16'      (12 files, ~0.7 GB)   4204 ≈ 8-11'  (48, ~1.3 GB)
#   4203 ≈ 5.6-8'      (48 files, ~2.6 GB)   4202 ≈ 4-5.6' (48, ~5 GB)
# Usage: download-astrometry-indexes [target-dir] [scales...]   (default scales: 4207 4206 4205 4204 4203)
set -eu
target=${1:-${ASTROMETRY_EXTRA_INDEX_DIRS:-/app/config/astrometry-index}}
[ "$#" -gt 0 ] && shift
scales=${*:-4207 4206 4205 4204 4203}
mkdir -p "$target"
# Keep the index license next to the data (shown in Admin → About AstroviaBin & third-party notices).
[ -s "$target/LICENSE-4200.txt" ] || curl -fsSL --retry 5 -o "$target/LICENSE-4200.txt" "https://data.astrometry.net/4200/LICENSE"
for scale in $scales; do
  case "$scale" in
    4205|4206|4207|4208|4209|4210|4211|4212|4213|4214|4215|4216|4217|4218|4219) count=11 ;;
    4200|4201|4202|4203|4204) count=47 ;;
    *) echo "Unknown index scale $scale" >&2; exit 2 ;;
  esac
  for i in $(seq -w 0 "$count"); do
    file="index-$scale-$i.fits"
    [ -s "$target/$file" ] && continue
    echo "Downloading $file"
    curl -fsSL --retry 5 -o "$target/$file.part" "https://data.astrometry.net/4200/$file"
    mv "$target/$file.part" "$target/$file"
  done
done
echo "Index files in $target: $(ls "$target" | grep -c '^index-.*\.fits$')"
