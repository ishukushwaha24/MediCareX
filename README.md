# MediCareX (frontend + Express backend)

## Run
    npm install
    npm start
Open http://localhost:3000 (do not open index.html directly; the page needs the server).

## Folder
    server.js          backend (login, token auth, data API, live push, auto-update timer)
    sim.js             demo simulator (changes beds, patients, doctors, medicines, ambulances)
    package.json
    public/index.html  frontend (served by the server)

## Settings (optional environment variables)
    ACCESS_CODE     Doctor/Staff code (default 482916)
    TOKEN_SECRET    secret used to sign login tokens (set a fixed value so logins survive restarts)
    PORT            default 3000
    SIMULATE=0      turn off the 5-minute demo auto-updates
    TICK_SECONDS    auto-update interval in seconds (default 300)
