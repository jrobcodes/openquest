#!/bin/bash
# Copy data files from the pipeline output to the website public directory
SRC="../data/midnight"
DEST="public/data"

cd "$(dirname "$0")/.."

cp "$SRC/guide-full.json" "$DEST/"
cp "$SRC/quests.json" "$DEST/"
cp "$SRC/extras.json" "$DEST/"
cp "$SRC/stats.json" "$DEST/"
cp "$SRC/guide-full-stats.json" "$DEST/"

echo "Synced data files to $DEST/"
