// utils.js
const WebSocket = require('ws'); 
const { users, rooms, players, clientToRoomMap } = require('./state');

function generateUniqueID(length = 6) {
    return Math.random().toString(36).substring(2, 2 + length).toUpperCase();
}

function getRoomData(roomID) {
    const room = rooms.get(roomID);
    if (!room) return null;

    const allPlayersData = [];
    for (const [playerId, state] of players.entries()) {
        if (clientToRoomMap.get(playerId) === roomID) {
            allPlayersData.push({
                id: playerId,
                username: state.username,
                score: state.score,
                climberPosition: state.climberPosition,
                isHost: room.hostID === playerId,
                // --- NOVINKA: Přidání kotev do dat pro Unity ---
                anchorsLeft: state.anchorsLeft,
                anchorHeight: state.anchorHeight
            });
        }
    }
    return { room, allPlayersData };
}

function broadcastToRoom(roomID, message) {
    const room = rooms.get(roomID);
    if (!room) return;

    for (const [playerId] of players.entries()) {
        if (clientToRoomMap.get(playerId) === roomID) {
            const player = players.get(playerId);
            if (player && player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(message);
            }
        }
    }
}

module.exports = {
    generateUniqueID,
    getRoomData,
    broadcastToRoom,
};