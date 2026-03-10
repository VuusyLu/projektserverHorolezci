// server.js
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const express = require('express'); // PŘIDÁNO
const http = require('http');        // PŘIDÁNO

// --- KONFIGURACE EXPRESS A HTTP ---
const app = express();
const server = http.createServer(app);

// --- IMPORT MODULŮ ---
const { generateUniqueID, getRoomData, broadcastToRoom } = require('./utils'); 
const gameCoreModule = require('./gameCore'); 
const { rooms, players, clientToRoomMap } = require('./state');
const db = require('./db');

const WS_PORT = process.env.PORT || 8080;

// --- INICIALIZACE WEBSOCKET SERVERU ---
// Teď už neportujeme přímo tady, ale navážeme se na existující HTTP server
const wss = new WebSocket.Server({ server });

// Nastavení Webglobe SMTP
const transporter = nodemailer.createTransport({
    host: 'mail.webglobe.cz',
    port: 587,
    secure: false,
    auth: {
        user: 'noreply@horolezcihra.online',
        pass: 'Klukynek10' 
    }
});

// --- HTTP ENDPOINT PRO OVĚŘENÍ E-MAILU ---
// Na tohle klikne hráč v prohlížeči
app.get('/verify', (req, res) => {
    const token = req.query.token;

    if (!token) {
        return res.status(400).send("<h1>Chyba</h1><p>Neplatný ověřovací odkaz.</p>");
    }

    db.run(
        "UPDATE users SET isVerified = 1, verificationToken = NULL WHERE verificationToken = ?", 
        [token], 
        function(err) {
            if (err) {
                console.error("Chyba DB při verifikaci:", err);
                return res.status(500).send("Chyba serveru.");
            }
            if (this.changes === 0) {
                return res.status(400).send("<h1>Odkaz neplatný</h1><p>Účet už byl ověřen nebo odkaz vypršel.</p>");
            }
            
            res.send(`
                <div style="text-align:center; font-family: sans-serif; padding-top: 50px;">
                    <h1 style="color: #4CAF50;">E-mail úspěšně potvrzen! 🧗‍♂️</h1>
                    <p>Tvůj účet je nyní aktivní. Můžeš se vrátit do Unity a přihlásit se.</p>
                </div>
            `);
        }
    );
});

// --- DEKLARACE KLÍČOVÝCH FUNKCÍ ---

// 1. Deklarace, aby byly funkce viditelné v celém server.js
let gameCore = {}; 

function broadcastGameState(roomID, specificMessage = null) {
    const data = getRoomData(roomID); 
    if (!data) return;

    const { room, allPlayersData } = data;
    
    // kontrola hádanky
    const isFinished = room.remainingLetters.length === 0;

    // sestavení tajenky
    const displayPhrase = room.currentPhrase
        .split('')
        .map(c => gameCore.ALPHABET.includes(c) && !room.guessedLetters.has(c) ? '-' : c) 
        .join('');

    // 3. Sestavíme balíček dat pro Unity
    const message = specificMessage || {
        type: 'STATE_UPDATE',
        players: allPlayersData, 
        phrase: displayPhrase,
        category: room.currentCategory,
        letters: isFinished ? [] : gameCore.generateRandomLetters(room), 
        timeLimit: gameCore.GUESS_TIME_LIMIT_SECONDS, 
        isFinished: isFinished,
        targetClimbHeight: room.targetClimbHeight, 
        roomID: roomID,
    };

    // 4. Logika pro další krok (Časovače a konce her)
    if (!isFinished) {
        // Hra běží -> spustíme časovač na další tah
        startNewRoundTimer(roomID); 
    } else {
        // Hra skončila (hádanka je doplněná) -> zastavíme časovač
        if (room.roundTimer) clearTimeout(room.roundTimer);
        
        console.log(`SERVER[${roomID}]: Hádanka vyluštěna.`);

        if (room.isDailyChallenge) {
            // KONEC DAILY CHALLENGE
            setTimeout(() => {
                broadcastToRoom(roomID, JSON.stringify({ 
                    type: 'GAME_OVER_DAILY', 
                    message: 'Gratulujeme! Dokončil jsi dnešní výzvu.' 
                }));
                // Místnost po chvíli smažeme z paměti
                setTimeout(() => rooms.delete(roomID), 1000);
            }, 5000); 
        } else {
            // POKRAČOVÁNÍ V SOLO / MULTI (nová hádanka)
            setTimeout(() => {
                gameCore.initializeNewPuzzle(room, false).then(() => {
                    broadcastGameState(roomID); 
                }).catch(err => console.error("Chyba inicializace:", err));
            }, 5000);
        }
    }

    // 5. Samotné odeslání zprávy všem připojeným klientům
    allPlayersData.forEach(playerData => {
        const player = players.get(playerData.id);
        if (player && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    });
}

function startNewRoundTimer(roomID) {
    // Voláme gameCore funkci a předáme I/O funkce
    gameCore.startNewRoundTimer(roomID, broadcastToRoom, broadcastGameState);
}

// Inicializace gameCore 
gameCore = {
    ...gameCoreModule, // Kopírujeme všechny funkce a konstanty
    startNewRoundTimer: (roomID) => gameCoreModule.startNewRoundTimer(roomID, broadcastToRoom, broadcastGameState),
    handlePlayerGuess: (data) => gameCoreModule.handlePlayerGuess(data, broadcastToRoom, broadcastGameState),
    processRoundResults: (roomID) => gameCoreModule.processRoundResults(roomID, broadcastToRoom, broadcastGameState),
};
// --- KONEC DEKLARACE ---


// --- ZPRACOVÁNÍ ZPRÁV ---
async function handleSystemMessages(ws, data) {
    const { type, username, password, authType, roomID } = data;
    let response;

    if (type === 'GUEST_JOIN') {
        let isUnique = false;
        let guestNum, guestId, guestUsername;
        
        while (!isUnique) {
            guestNum = Math.floor(1000 + Math.random() * 9000);
            guestId = `GUEST_${guestNum}`;
            guestUsername = `Host${guestNum}`;

            if (!players.has(guestId)) {
                isUnique = true;
            }
        }

        // DŮLEŽITÉ: Struktura musí odpovídat tvému utils.getRoomData
        players.set(guestId, { 
            ws: ws, 
            id: guestId, 
            username: guestUsername, 
            score: 0, 
            climberPosition: 0,
            isGuest: true 
        });

        ws.playerId = guestId;
        ws.username = guestUsername;

        console.log(`[SERVER] Vytvořen host: ${guestUsername}`);
        
        ws.send(JSON.stringify({ 
            type: 'AUTH_SUCCESS', 
            playerId: guestId, 
            message: `Jsi připojen jako ${guestUsername}` 
        }));
        return;
    }

    if (type === 'AUTH_REQUEST') {
        console.log(`🔐 AuthRequest detekován. Typ: ${data.authType}, Jméno: ${data.username}`); // <-- PŘIDAT
    if (authType === 'REGISTER') {
        console.log("📝 Začínám registraci v DB pro: " + username);
        const { email } = data;

        // 1. Kontrola, zda uživatel nebo e-mail už neexistuje
        db.get("SELECT * FROM users WHERE username = ? OR email = ?", [username, email], (err, row) => {
            if (err) {
                console.error("DB Error:", err);
                ws.send(JSON.stringify({ type: 'AUTH_FAILURE', message: 'Chyba serveru při kontrole dat.' }));
                return;
            }

            if (row) {
                console.log("⚠️ Uživatel nebo e-mail již existuje: " + username);
                const reason = row.username === username ? "Jméno" : "E-mail";
                ws.send(JSON.stringify({ type: 'AUTH_FAILURE', message: `${reason} již existuje.` }));
                return;
            }

            // 2. Vše v pořádku -> Vytvoříme ID a Token
            const newPlayerId = generateUniqueID(8);
            const verificationToken = crypto.randomBytes(32).toString('hex');

            // 3. Zápis do DB (isVerified = 0)
            db.run(
                "INSERT INTO users (playerId, username, password, email, verificationToken, isVerified) VALUES (?, ?, ?, ?, ?, ?)", 
                [newPlayerId, username, password, email, verificationToken, 0], 
                function(err) {
                    if (err) {
                        console.error("Insert Error:", err);
                        ws.send(JSON.stringify({ type: 'AUTH_FAILURE', message: 'Chyba při vytváření účtu.' }));
                        return;
                    }

                    console.log("✅ Uživatel zapsán do DB. Odpovídám Unity.");

                    // --- KLÍČOVÁ ZMĚNA: Odpovíme Unity HNED, nečekáme na mail ---
                    ws.send(JSON.stringify({ 
                        type: 'AUTH_SUCCESS', 
                        playerId: newPlayerId, 
                        message: 'Registrace úspěšná! Potvrď svůj e-mail (zkontroluj i Spam).' 
                    }));

                    // 4. Odeslání e-mailu na pozadí
                    // Pokud jsi na Renderu, localhost nebude fungovat, použijeme relativní host z hlavičky (pokud je dostupný) nebo tvou URL
                    const verifyUrl = `http://localhost:8080/verify?token=${verificationToken}`; 
                    
                    const mailOptions = {
                        from: '"Horolezci Hra" <noreply@horolezcihra.online>',
                        to: email,
                        subject: 'Potvrzení registrace - Horolezci Hra',
                        html: `
                            <div style="font-family: Arial, sans-serif; padding: 20px;">
                                <h2>Vítej, ${username}!</h2>
                                <p>Pro aktivaci účtu klikni na tlačítko:</p>
                                <a href="${verifyUrl}" style="background: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">AKTIVOVAT ÚČET</a>
                            </div>
                        `
                    };

                    console.log("📧 Odesílám mail přes SMTP (587)...");
                    transporter.sendMail(mailOptions, (error, info) => {
                        if (error) {
                            console.error("❌ CHYBA MAILU:", error.message);
                        } else {
                            console.log("📧 MAIL OK:", info.response);
                        }
                    });
                }
            );
        });
        return;
    }

    if (authType === 'LOGIN') {
    const { username, email, password } = data;

    // Hledáme uživatele, kde sedí BUĎ jméno, NEBO email, a k tomu VŽDY heslo
    db.get(
        "SELECT * FROM users WHERE (username = ? OR email = ?) AND password = ?", 
        [username, email, password], 
        (err, row) => {
            if (err) {
                console.error("Login DB Error:", err);
                ws.send(JSON.stringify({ type: 'AUTH_FAILURE', message: 'Chyba databáze.' }));
                return;
            }

            if (row) {
                // KONTROLA AKTIVACE (Nodemailer v akci)
                if (row.isVerified === 0) {
                    ws.send(JSON.stringify({ 
                        type: 'AUTH_FAILURE', 
                        message: 'Účet není aktivován. Klikněte na odkaz v e-mailu!' 
                    }));
                    return;
                }

                // Úspěšné přihlášení
                const response = { 
                    type: 'AUTH_SUCCESS', 
                    playerId: row.playerId, 
                    message: `Vítej zpět, ${row.username}!` 
                };

                players.set(row.playerId, { 
                    ws, id: row.playerId, username: row.username, score: 0, climberPosition: 0, isGuest: false 
                });

                ws.playerId = row.playerId;
                ws.username = row.username;
                ws.send(JSON.stringify(response));
                console.log(`[LOGIN] Hráč ${row.username} se přihlásil.`);
            } else {
                ws.send(JSON.stringify({ type: 'AUTH_FAILURE', message: 'Neplatné jméno/e-mail nebo heslo.' }));
            }
        }
    );
    return;
}
}
    if (!ws.playerId) return; 
    const playerId = ws.playerId;

    if (type === 'CREATE_ROOM') {
        const newRoomID = generateUniqueID(6);
        const newRoom = {
            id: newRoomID,
            hostID: playerId,
            targetClimbHeight: 0, 
            remainingLetters: [],
            guessedLetters: new Set(),
            isProcessing: false,
            roundTimer: null,
            currentRoundGuesses: new Map(),
        };
        rooms.set(newRoomID, newRoom);
        clientToRoomMap.set(playerId, newRoomID);
        broadcastLobbyUpdate(newRoomID);
        return;
    }
    
    if (type === 'JOIN_ROOM') {
        let roomToJoinID = roomID;
        if (roomID === 'RANDOM') {
            const availableRoom = Array.from(rooms.values()).find(r => Array.from(players.keys()).filter(p => clientToRoomMap.get(p) === r.id).length < 4);
            if (availableRoom) {
                roomToJoinID = availableRoom.id;
            } else {
                ws.send(JSON.stringify({ type: 'ROOM_FAILURE', message: 'Nenašli jsme volnou místnost.' }));
                return;
            }
        }
        
        const roomToJoin = rooms.get(roomToJoinID);
        if (roomToJoin) {
            clientToRoomMap.set(playerId, roomToJoinID);
            broadcastLobbyUpdate(roomToJoinID);
        } else {
            ws.send(JSON.stringify({ type: 'ROOM_FAILURE', message: 'Místnost neexistuje.' }));
        }
        return;
    }
    
    if (type === 'LEAVE_ROOM') {
        const currentRoomID = clientToRoomMap.get(playerId);
        if (!currentRoomID) return;
        
        clientToRoomMap.delete(playerId);
        const roomState = rooms.get(currentRoomID);
        
        if (roomState && roomState.hostID === playerId) {
            rooms.delete(currentRoomID);
            broadcastToRoom(currentRoomID, JSON.stringify({ type: 'ROOM_CLOSED', message: 'Hostitel opustil místnost.' }));
            console.log(`SERVER: Místnost ${currentRoomID} zrušena (hostitel odešel).`);
            return;
        }
        broadcastLobbyUpdate(currentRoomID);
        return;
    }
    
    if (type === 'START_GAME') {
        const currentRoomID = clientToRoomMap.get(playerId);
        const roomState = rooms.get(currentRoomID);
        
        if (roomState && roomState.hostID === playerId) {
            broadcastToRoom(currentRoomID, JSON.stringify({ type: 'GAME_START' }));
            
            gameCore.initializeNewPuzzle(roomState, true).then(() => {
                broadcastGameState(currentRoomID); 
            });
        }
        return;
    }
    
    if (type === 'START_SOLO_GAME' || type === 'START_DAILY_CHALLENGE') {
        console.log(`SERVER: Přijat požadavek na ${type} od hráče ${playerId}`);
        const isDaily = (type === 'START_DAILY_CHALLENGE');
        const newRoomID = (isDaily ? "DAILY_" : "SOLO_") + generateUniqueID(4);
    
        const newRoom = {
            id: newRoomID,
            hostID: playerId,
            targetClimbHeight: 0, 
            remainingLetters: [],
            guessedLetters: new Set(),
            isProcessing: false,
            roundTimer: null,
            currentRoundGuesses: new Map(),
            isDailyChallenge: isDaily,
            isPrivate: true
        };

        rooms.set(newRoomID, newRoom);
        clientToRoomMap.set(playerId, newRoomID);

        // Potvrzení pro Unity, že hra začíná
        ws.send(JSON.stringify({ type: 'GAME_START', roomID: newRoomID }));
    
        // Inicializace tajenky
        gameCore.initializeNewPuzzle(newRoom, true).then(() => {
            broadcastGameState(newRoomID); 
        }).catch(err => {
            console.error("Chyba při inicializaci solo/daily hry:", err);
        });
        return;
    }
}

// ---  ODESÍLÁNÍ STAVU LOBBY
function broadcastLobbyUpdate(roomID) {
    const data = getRoomData(roomID);
    if (!data) return;

    const { room, allPlayersData } = data;
    
    const message = {
        type: 'LOBBY_UPDATE',
        roomID: roomID,
        hostID: room.hostID,
        players: allPlayersData,
    };
    broadcastToRoom(roomID, JSON.stringify(message));
}


// --- WEBSOCKET ŘÍZENÍ SPOJENÍ ---

wss.on('connection', function connection(ws) {
    console.log('🔗 Nový klient se pokouší připojit.');

    ws.on('message', function incoming(message) {
        console.log('📥 SERVER PŘIJAL DATA:', message.toString()); // <-- PŘIDAT TENTO LOG
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error("SERVER: Neplatný JSON:", message);
            return;
        }

        // TADY BYLA CHYBA: Chybělo zde data.type === 'GUEST_JOIN'
        if (data.type === 'GUEST_JOIN' || // <--- PŘIDÁNO
            data.type === 'AUTH_REQUEST' ||
            data.type === 'CREATE_ROOM' ||
            data.type === 'JOIN_ROOM' ||
            data.type === 'LEAVE_ROOM' ||
            data.type === 'START_GAME' ||
            data.type === 'START_SOLO_GAME' ||
            data.type === 'START_DAILY_CHALLENGE'
        ) {
            handleSystemMessages(ws, data);
            return;
        }

        // --- Zpracování Herních Tahů ---
        // Tato část vyžaduje, aby hráč už měl playerId (což GUEST_JOIN teprve vytváří)
        if (!ws.playerId) {
            console.warn("SERVER: Přijata herní zpráva od neautorizovaného klienta.");
            return; 
        }

        const roomID = clientToRoomMap.get(ws.playerId); 
        if (!roomID) return; 

        if (data.type === 'GUESS_LETTER' || data.type === 'NO_GUESS') {
            const fullGuessData = {
                ...data, 
                playerId: ws.playerId,
                roomID: roomID 
            };

            gameCore.handlePlayerGuess(fullGuessData); 
            return;
        }
    });

    ws.on('close', () => {
        if (ws.playerId) {
            const playerId = ws.playerId;
            const roomID = clientToRoomMap.get(playerId);
            
            if (roomID) {
                 handleSystemMessages(ws, { type: 'LEAVE_ROOM', roomID: roomID }); 
            }

            players.delete(playerId);
            clientToRoomMap.delete(playerId);
        }
        console.log('❌ Klient odpojen.');
    });
});

server.listen(WS_PORT, '0.0.0.0', () => {
    console.log(`🚀 Server běží na portu ${WS_PORT} (HTTP + WebSocket)`);
});