#!/bin/bash
pkill -9 -f 'node.*index.mjs' 2>/dev/null
sleep 2
rm -f /home/dinhhoangg1991/twitter-comment-pack/data/store.db*
cd /home/dinhhoangg1991/twitter-comment-pack
exec node src/index.mjs
