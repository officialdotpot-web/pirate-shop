# Deploy on Render

This package is prepared for Render but has not been deployed to your account.

1. Upload the contents of this folder to a GitHub repository. `render.yaml` must be at the repository root, alongside `pirate-gift-shop-v8.html` and `server/`.
2. On Render, select **New → Blueprint**, connect that repository, and deploy. The Blueprint creates a Node web service using the free plan and generates a random `BRIDGE_PASSWORD`.
3. In Render's service **Environment** tab, view `BRIDGE_PASSWORD`. Open the Render service URL in a browser. When prompted, enter username `pirate` and that password. Keep it private; anyone with it can view the LIVE events and control the bridge.
4. In the app, open Settings → TikTok LIVE, enter your TikTok handle and press Connect LIVE while you are live. Keep the browser open while using the gift queue.

The free Render tier can spin down after inactivity, losing the in-memory TikTok connection and queue. Reconnect if the instance restarts. A paid always-on instance may be appropriate for a production stream, but deployments and restarts can still disconnect it. Usernames and queue state are not durable; use a persistent storage system before relying on them.

The bridge is password protected in production. `/healthz` is public and reports only liveness. Passwordless startup is refused on Render. Do not put the password in the repo or share it publicly. Open the app from its Render URL instead of a separate HTML file: the app and API must be on the same origin for authentication.

**The bridge only receives TikTok events. It does not process payments or send Fortnite gifts.** No delivery estimate can be guaranteed. Real fulfillment requires a legitimate payment provider and an authorized fulfillment integration.

Gift-catalog reference source: https://github.com/1363306384/streamplay-gift-catalog. Gift images and availability vary by region; default images are included and others load over the internet.
