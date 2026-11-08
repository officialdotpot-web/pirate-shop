# Pirate Shop bridge

The bridge connects to TikTok LIVE using an unofficial library, guesses usernames from chat, and runs an in-memory priority queue. See `../DEPLOY.md` for Render setup, automatic connection, important queue limitations, and hosting requirements. No real payment or Fortnite delivery is implemented.

For local testing: `npm install`, `npm start`, then open http://localhost:8787. Set `TIKTOK_USERNAME` to try auto-connecting. Defaults: Hand Hearts → first bundle; Money Gun → middle; Galaxy → third. Regular chat → middle. Gift mappings are editable in the page while connected, but reset when the process restarts.
