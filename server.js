const WebSocket = require('ws');
const { Resend } = require('resend'); // Změněno z nodemailer
const resend = new Resend('re_44KUgwsT_5chcpZZxWmdbjkAESncmxkRP');
const crypto = require('crypto');
const express = require('express');
const http = require('http');

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
const wss = new WebSocket.Server({ server });

// --- HTTP ENDPOINT PRO OVĚŘENÍ E-MAILU ---
// Na tohle klikne hráč v prohlížeči
app.get('/verify', (req, res) => {
    const token = req.query.token;

    if (!token) {
        return res.status(400).send("<h1>Chyba</h1><p>Neplatný ověřovací odkaz.</p>");
    }

    // Najdeme uživatele s tímto tokenem a aktivujeme ho
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
    if (!data || !data.room) return;

    const { room, allPlayersData } = data;
    if (!room.currentPhrase) return;
    
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
    if (type === 'LOGOUT_REQUEST') {
        const oldName = ws.username || "Neznámý";
        const oldId = ws.playerId || "Neznámé ID";
        console.log(`👤 Odhlášení hráče: ${oldName} (${oldId})`);

        if (ws.playerId) {
            const roomID = clientToRoomMap.get(ws.playerId);
            if (roomID) {
                // Přidáno await pro stabilitu
                await handleSystemMessages(ws, { type: 'LEAVE_ROOM', roomID: roomID });
            }
            players.delete(ws.playerId);
            clientToRoomMap.delete(ws.playerId); // Smažeme i mapování místnosti
        }

        ws.playerId = null;
        ws.username = null;

        console.log("🔄 Generuji novou identitu Hosta...");
        // Přidáno await, aby se nová identita poslala až po vyčištění staré
        await handleSystemMessages(ws, { type: 'GUEST_JOIN' });
        
        console.log("✅ Odhlášení dokončeno.");
        return;
    }

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
        console.log("📝 Start registrace přes Resend API pro: " + username);
        const { email } = data;

        db.get("SELECT * FROM users WHERE username = ? OR email = ?", [username, email], (err, row) => {
            if (err) {
                console.error("Chyba DB:", err);
                ws.send(JSON.stringify({ type: 'AUTH_FAILURE', message: 'Chyba serveru při kontrole dat.' }));
                return;
            }

            if (row) {
                console.log("⚠️ Uživatel nebo e-mail již existuje: " + username);
                const reason = row.username === username ? "Jméno" : "E-mail";
                ws.send(JSON.stringify({ type: 'AUTH_FAILURE', message: `${reason} již existuje.` }));
                return;
            }

            const newPlayerId = generateUniqueID(8);
            const verificationToken = crypto.randomBytes(32).toString('hex');

            db.run(
                "INSERT INTO users (playerId, username, password, email, verificationToken, isVerified) VALUES (?, ?, ?, ?, ?, ?)", 
                [newPlayerId, username, password, email, verificationToken, 0], 
                function(err) {
                    if (err) {
                        console.error("Insert Error:", err);
                        ws.send(JSON.stringify({ type: 'AUTH_FAILURE', message: 'Chyba při vytváření účtu.' }));
                        return;
                    }

                    // Nezapomeň si v této URL zkontrolovat, zda sedí název tvé appky na Renderu
                    const verifyUrl = `https://projektserverhorolezci.onrender.com/verify?token=${verificationToken}`;
                    console.log("📧 Volám Resend API pro: " + email);

                    resend.emails.send({
                        from: 'Horolezci Hra <onboarding@resend.dev>',
                        to: email,
                        subject: 'Aktivace účtu - Horolezci Hra',
                        html: `
                            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                                <h2 style="color: #4CAF50;">Vítej v týmu, ${username}!</h2>
                                <p>Tvůj účet byl vytvořen. Pro aktivaci klikni na tlačítko níže:</p>
                                <div style="text-align: center; margin: 30px 0;">
                                    <a href="${verifyUrl}" style="background: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">AKTIVOVAT ÚČET</a>
                                </div>
                                <p style="font-size: 0.8em; color: #888;">Pokud tlačítko nefunguje, použij tento odkaz: <br> ${verifyUrl}</p>
                            </div>
                        `
                    }).then(() => {
                        console.log("✅ RESEND: Mail úspěšně odeslán!");
                        ws.send(JSON.stringify({ 
                            type: 'AUTH_SUCCESS', 
                            message: 'Registrace úspěšná! Potvrď svůj e-mail (zkontroluj i Spam).' 
                        }));
                    }).catch(error => {
                        console.error("❌ RESEND ERROR:", error);
                        ws.send(JSON.stringify({ 
                            type: 'AUTH_FAILURE', 
                            message: 'Účet vytvořen, ale nepodařilo se odeslat aktivační e-mail.' 
                        }));
                    });
                }
            );
        });
        return;
    }

    if (authType === 'LOGIN') {
        const { username, email, password } = data;

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
                    // Tady kontrolujeme, zda uživatel klikl na ten odkaz v mailu
                    if (row.isVerified === 0) {
                        ws.send(JSON.stringify({ 
                            type: 'AUTH_FAILURE', 
                            message: 'Účet není aktivován. Klikni na odkaz v e-mailu!' 
                        }));
                        return;
                    }

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
            isPublic: true,
            targetClimbHeight: 0,
            readyPlayers: new Set(),
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
        
        // 1. Logika pro náhodnou místnost (včetně kontroly isPublic a kapacity)
        if (roomID === 'RANDOM') {
            const availableRoom = Array.from(rooms.values()).find(r => 
                r.isPublic === true && 
                Array.from(players.keys()).filter(p => clientToRoomMap.get(p) === r.id).length < 4
            );
            
            if (availableRoom) {
                roomToJoinID = availableRoom.id;
            } else {
                ws.send(JSON.stringify({ type: 'ROOM_FAILURE', message: 'Žádná veřejná místnost není volná.' }));
                return;
            }
        }
        
        // 2. Kontrola konkrétní místnosti (i té náhodně vybrané výše)
        const roomToJoin = rooms.get(roomToJoinID);
        if (roomToJoin) {
            // --- TADY PŘIDÁME KONTROLU KAPACITY ---
            const currentPlayersCount = Array.from(players.keys())
                .filter(p => clientToRoomMap.get(p) === roomToJoinID).length;

            if (currentPlayersCount >= 4) {
                ws.send(JSON.stringify({ type: 'ROOM_FAILURE', message: 'Místnost je již plná (max 4 hráči).' }));
                return;
            }
            // --------------------------------------

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
        
        const roomState = rooms.get(currentRoomID);
        clientToRoomMap.delete(playerId); // Hráč už v místnosti není
        
        if (roomState && roomState.hostID === playerId) {
            broadcastToRoom(currentRoomID, JSON.stringify({ 
                type: 'ROOM_CLOSED', 
                message: 'Hostitel opustil místnost.' 
            }));

            rooms.delete(currentRoomID);
            
            console.log(`SERVER: Místnost ${currentRoomID} zrušena (hostitel odešel).`);
            return;
        }

        broadcastLobbyUpdate(currentRoomID);
        return;
    }
    if (type === 'SET_LOBBY_PUBLIC') {
        const currentRoomID = clientToRoomMap.get(playerId);
        const roomState = rooms.get(currentRoomID);
        
        if (roomState && roomState.hostID === playerId) {
            roomState.isPublic = data.value; // Uložíme true/false
            console.log(`Místnost ${currentRoomID} je nyní ${data.value ? 'VEŘEJNÁ' : 'SOUKROMÁ'}`);
            broadcastLobbyUpdate(currentRoomID); // Rozešleme info všem
        }
        return;
    }
    
    if (type === 'START_GAME') {
        const currentRoomID = clientToRoomMap.get(playerId);
        const roomState = rooms.get(currentRoomID);
        
        if (roomState && roomState.hostID === playerId) {
            roomState.readyForAction = new Set(); // Reset připravenosti v nové scéně
            
            // Pošleme všem pokyn k přepnutí scény
            broadcastToRoom(currentRoomID, JSON.stringify({ type: 'GAME_START' }));

            // POJISTKA: Start hry po 20s, i kdyby někdo neklikl na Ready
            if (roomState.forceStartTimer) clearTimeout(roomState.forceStartTimer);
            roomState.forceStartTimer = setTimeout(() => {
                startGameSession(currentRoomID);
            }, 20000); 
        }
        return;
    }

    if (type === 'CLIENT_SCENE_READY') {
        const currentRoomID = clientToRoomMap.get(playerId);
        const roomState = rooms.get(currentRoomID);
        if (!roomState) return;

        const playersInRoom = Array.from(players.keys()).filter(p => clientToRoomMap.get(p) === currentRoomID);

        roomState.readyForAction.add(playerId);
        
        // Informujeme Unity o stavu 1/4, 2/4 atd.
        broadcastToRoom(currentRoomID, JSON.stringify({ 
            type: 'SCENE_READY_COUNT', 
            readyCount: roomState.readyForAction.size,
            totalCount: playersInRoom.length
        }));

        // Pokud jsou všichni Ready, startujeme hned
        if (roomState.readyForAction.size === playersInRoom.length) {
            if (roomState.forceStartTimer) clearTimeout(roomState.forceStartTimer);
            startGameSession(currentRoomID);
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
    
    // Ke každému hráči přilepíme informaci, jestli je Ready
    const playersWithReady = allPlayersData.map(p => ({
        ...p,
        isReady: room.readyPlayers.has(p.id)
    }));

    const message = {
        type: 'LOBBY_UPDATE',
        roomID: roomID,
        hostID: room.hostID,
        isPublic: room.isPublic || false,
        players: playersWithReady, // Posíláme rozšířená data
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
        if (data.type === 'GUEST_JOIN' ||
            data.type === 'LOGOUT_REQUEST' ||
            data.type === 'AUTH_REQUEST' ||
            data.type === 'CREATE_ROOM' ||
            data.type === 'JOIN_ROOM' ||
            data.type === 'CLIENT_SCENE_READY' ||
            data.type === 'LEAVE_ROOM' ||
            data.type === 'SET_LOBBY_PUBLIC' ||
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
function startGameSession(roomID) {
    const roomState = rooms.get(roomID);
    if (!roomState || roomState.currentPhrase) return; // Pokud už hra běží, nedělej nic

    gameCore.initializeNewPuzzle(roomState, true).then(() => {
        broadcastGameState(roomID); 
    }).catch(err => console.error("Chyba při startu sezení:", err));
}

server.listen(WS_PORT, '0.0.0.0', () => {
    console.log(`🚀 Server běží na portu ${WS_PORT} (HTTP + WebSocket)`);
});