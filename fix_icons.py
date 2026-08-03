#!/usr/bin/env python3
"""Simple webp to png converter using only standard library + try various approaches."""
import os
import sys
import shutil

# Source and target directories
src_root = '/opt/data/upn-clean/android/app/src/main/res'

# Convert webp to png by copying and renaming (Android can decode webp in some cases)
# But the proper fix: copy logo.png to ic_launcher_foreground.png in all densities

logo_path = '/opt/data/upn-clean/assets/images/logo.png'
if not os.path.exists(logo_path):
    print(f"Logo not found at {logo_path}")
    sys.exit(1)

# Densities
densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']

for density in densities:
    src_webp = os.path.join(src_root, f'mipmap-{density}', 'ic_launcher_foreground.webp')
    dst_png = os.path.join(src_root, f'mipmap-{density}', 'ic_launcher_foreground.png')
    round_src = os.path.join(src_root, f'mipmap-{density}', 'ic_launcher_round.webp')
    round_dst = os.path.join(src_root, f'mipmap-{density}', 'ic_launcher_round.png')
    
    # Copy logo.png as the foreground icon
    shutil.copy2(logo_path, dst_png)
    print(f"Copied {logo_path} -> {dst_png}")
    
    # Also copy for round
    shutil.copy2(logo_path, round_dst)
    print(f"Copied {logo_path} -> {round_dst}")

# For anydpi, just ensure the XML references exist
print("Done converting icons")