// server.js
const WebSocket = require('ws');
// --- IMPORT MODULŮ ---
const { generateUniqueID, getRoomData, broadcastToRoom } = require('./utils'); 
const gameCoreModule = require('./gameCore'); // Importujeme celý modul gameCore
const { rooms, players, clientToRoomMap } = require('./state');

const db = require('./db');
//nastavení portu
const WS_PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({ 
    port: WS_PORT,
    host: '0.0.0.0' 
}, () => {
    console.log(`Server běží a naslouchá na portu: ${WS_PORT}`);
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

    if (type === 'AUTH_REQUEST') {
    if (authType === 'REGISTER') {
        db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
            if (row) {
                ws.send(JSON.stringify({ type: 'AUTH_FAILURE', message: 'Uživatel již existuje.' }));
            } else {
                const newPlayerId = generateUniqueID(8);
                // Zápis do DB
                db.run("INSERT INTO users (playerId, username, password) VALUES (?, ?, ?)", [newPlayerId, username, password], function(err) {
                    if (err) {
                        ws.send(JSON.stringify({ type: 'AUTH_FAILURE', message: 'Chyba při registraci.' }));
                    } else {
                        const response = { type: 'AUTH_SUCCESS', playerId: newPlayerId, message: `Vítej, ${username}! Registrace OK.` };
                        
                        // Přidání do aktivních hráčů v paměti
                        players.set(newPlayerId, { ws, id: newPlayerId, username, score: 0, climberPosition: 0 });
                        ws.playerId = newPlayerId;
                        ws.username = username;
                        
                        ws.send(JSON.stringify(response));
                    }
                });
            }
        });
        return;
    }

    if (authType === 'LOGIN') {
        // Hledání v DB
        db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
            if (row) {
                const response = { type: 'AUTH_SUCCESS', playerId: row.playerId, message: `Vítej zpět, ${username}!` };
                
                // Přidání do aktivních hráčů (online list)
                players.set(row.playerId, { ws, id: row.playerId, username: row.username, score: 0, climberPosition: 0 });
                ws.playerId = row.playerId;
                ws.username = row.username;
                
                ws.send(JSON.stringify(response));
            } else {
                ws.send(JSON.stringify({ type: 'AUTH_FAILURE', message: 'Neplatné jméno nebo heslo.' }));
            }
        });
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
    console.log('🔗 Nový klient se pokouší připojit (čeká na AUTH).');

    ws.on('message', function incoming(message) {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error("SERVER: Neplatný JSON:", message);
            return;
        }

        if (data.type === 'AUTH_REQUEST' ||
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
        
        if (!ws.playerId) return; 
        const roomID = clientToRoomMap.get(ws.playerId); 
        if (!roomID) return; 

        if (data.type === 'GUESS_LETTER' || data.type === 'NO_GUESS') {
            const fullGuessData = {
                ...data, 
                playerId: ws.playerId,
                roomID: roomID 
            };

            // Voláme delegovanou funkci z gameCore
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

console.log(`✅ WebSocket server běží a čeká na připojení na ws://localhost:${WS_PORT}`);