# Live Scoreboard (5 users)

Run:  npm start   (needs Node 16+, no dependencies)

Open  /admin?key=ADMIN_KEY  to see all 5 users' links (the key is printed in the server log,
or set it yourself with the ADMIN_KEY environment variable).

Each user gets:
- Controller link  /c/...  -> private, has the +/- buttons and reset
- Overlay link     /o/...  -> paste into TikTok LIVE Studio (Link / Web source), transparent background

Recommended environment variables when deploying (keeps links the same after restarts):
  SECRET=<any long random text>
  ADMIN_KEY=<any password you choose>
  PUBLIC_URL=https://your-app-url   (optional)
