# Pirate Shop TikTok LIVE bridge

Run `npm install` and then `npm start` in this directory. Open http://localhost:8787, go to Settings → TikTok LIVE, enter the streamer's username and connect while the account is live. The connector is unofficial and a real connection depends on TikTok availability.

Default rules: Hand Hearts (including names containing “hand heart”) → first option ($199.99); Money Gun → middle option ($149.99); Galaxy → third option ($219.99). These are gift names, not coin thresholds. Select/search or type gift names in Settings. While connected the bridge attempts to load TikTok's available gift catalog; it may vary by room and region or be unavailable. Manual names are supported. Names must match the event sent by TikTok.

Each matching gift enters a FIFO priority queue. Its sender must then type their Fortnite username in LIVE chat (or `!gift username`); another viewer cannot claim it. Usernames must be at least 5 characters and are not verified with Epic. User avatars for unverified names are illustrative. A matching username selects the bundle and opens checkout. There is a skip button. The queue is in the open browser tab and is not durable; don't reload or disconnect during requests. Simulate event creates a gift and then a username on alternating clicks. Demo stream and `/api/demo` provide additional local testing.

**Checkout is a demo. No payment is processed and no Fortnite gift is delivered.** A real payment provider and an authorized Fortnite fulfillment integration would have to be added and verified separately. Real TikTok LIVE event receipt and the gift catalog have not been verified with a live stream in this environment.

## Gift picker and images

Each bundle has an image-based searchable dropdown. The embedded reference snapshot contains 3,300 entries from the [Streamplay worldwide reference catalog](https://github.com/1363306384/streamplay-gift-catalog), retrieved November 7, 2026. It is not a list guaranteed to be available in a particular room or country. The bridge attempts to merge the connected room's actual gift list when available. Duplicate names can have different IDs, so choices bind to the selected gift ID; Hand Heart is intentionally matched as a family across variants. Default and common thumbnails are embedded; other thumbnails load from the reference catalog's GitHub image URLs and require internet access. Images returned by TikTok LIVE can also be used. TikTok assets belong to their respective owners.
