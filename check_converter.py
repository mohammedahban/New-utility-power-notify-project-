#!/usr/bin/env python3
"""Convert webp to png using system tools or download a converter."""
import subprocess
import os

# First check what's available
for tool in ['magick', 'convert', 'dwebp', 'cwebp']:
    try:
        subprocess.run([tool, '-version'], capture_output=True, check=True)
        print(f"Found: {tool}")
        break
    except:
        continue
else:
    print("No webp converter found")
    exit(1)