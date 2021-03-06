const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);
const got = require('got');
const querystring = require('querystring');

server.listen(8000);

app.use('/images', express.static(__dirname + '/images'));

app.get('*/utils.js', function (req, res) {
    res.sendFile(__dirname + '/shared/utils.js');
});

app.get('/index.css', function (req, res) {
    res.sendFile(__dirname + '/index/index.css');
});

app.get('/index.js', function (req, res) {
    res.sendFile(__dirname + '/index/index.js');
});

app.get('/', function (req, res) {
    res.sendFile(__dirname + '/index/index.html');
});

app.get('/rooms/rooms.css', function (req, res) {
    res.sendFile(__dirname + '/rooms/rooms.css');
});

app.get('/rooms/rooms.js', function (req, res) {
    res.sendFile(__dirname + '/rooms/rooms.js');
});

app.get('/rooms/*', function (req, res) {
    res.sendFile(__dirname + '/rooms/rooms.html');
});

app.get('/rooms', (req, res) => {
    res.redirect('/');
});

app.get('/internal/video/:id', async (req, res) => {
    const headers = req.headers;
    delete headers['host'];
    delete headers['referer'];
    delete headers['cookie'];
    const id = req.params.id;
    const url = `https://www.youtube.com/get_video_info?html5=1&video_id=${id}`
    try {
        const response = await got(url, {
            'headers': headers,
        });
        const body = await response.body;
        const playerResponse = JSON.parse(querystring.parse(body)['player_response']);
        const formats = playerResponse['streamingData']['formats']
            .sort((a, b) => (a.width > b.width ? -1 : 1))
            .filter(format => format.url !== undefined);
        const format = formats[0];
        return res.json({
            'url': format.url,
            'mimeType': format.mimeType,
            'thumbnailUrl': `https://i3.ytimg.com/vi/${req.params.id}/maxresdefault.jpg`,
            'title': playerResponse['videoDetails']['title'],
        });

    } catch (error) {
        console.log(error);
        return res.json({
            'error': 'Failed to load Youtube',
        });
    }
});

app.get('/internal/trends', async (req, res) => {
    const headers = req.headers;
    delete headers['host'];
    delete headers['referer'];
    delete headers['cookie'];
    for (let i = 0; i < 5; i++) {
        try {
            const response = await got('https://youtube.com/feed/trending', {
                'headers': headers,
            });
            const text = await response.body;
            const fullJSON = text.split('window["ytInitialData"] =')[1].split(';\n    window["ytInitialPlayerResponse"]')[0];
            const obj = JSON.parse(fullJSON);
            const trends = [].concat.apply(
                [],
                obj['contents']['twoColumnBrowseResultsRenderer']['tabs'][0]['tabRenderer']['content']['sectionListRenderer']['contents']
                    .filter(r => r['itemSectionRenderer']['contents'][0]['shelfRenderer']['title'] === undefined)
                    .map(r => r['itemSectionRenderer']['contents'][0]['shelfRenderer']['content']['expandedShelfContentsRenderer']['items'])
            ).map(item => item['videoRenderer']);
            const videoMetas = [];
            trends.forEach(video => {
                const thumbnails = video['thumbnail']['thumbnails'].sort((a, b) => (a.width > b.width ? -1 : 1));
                const thumbnail = thumbnails[0];
                videoMetas.push({
                    'url': `https://www.youtube.com/watch?v=${video['videoId']}`,
                    'thumbnailUrl': thumbnail.url,
                    'title': video['title']['runs'][0]['text'],
                });
            })
            res.json(videoMetas);
            return;
        } catch (error) {
            console.log(error);
            if (i === 4) {
                res.json({'error': 'Failed to load Youtube'});
                return;
            }
        }
    }
});

const rooms = {};

io.on('connection', (socket) => {
    let roomId;
    let clientId;

    socket.on('init', (data) => {
        roomId = data['room'];
        clientId = data['client'];
        socket.join(roomId);
        if (rooms[roomId] === undefined) {
            rooms[roomId] = {
                'video': null,
                'timestamp': 0,
                'playing': false,
                'participants': [clientId],
                'master': clientId,
                'last_update': Date.now(),
            };
        } else {
            rooms[roomId].participants.push(clientId);
            rooms[roomId].last_update = Date.now();
            socket.broadcast.to(roomId).emit('participants', rooms[roomId].participants);
        }
        if (rooms[roomId].playing) {
            const now = Date.now() / 1000;
            rooms[roomId].timestamp += now - rooms[roomId].last_update;
            rooms[roomId].last_update = now;
        }
        socket.emit('state', rooms[roomId]);
    });
    socket.on('video', id => {
        rooms[roomId].video = id;
        rooms[roomId].timestamp = 0;
        rooms[roomId].last_update = Date.now();
        socket.broadcast.to(roomId).emit('video', id);
    });
    socket.on('play', () => {
        rooms[roomId].playing = true;
        rooms[roomId].last_update = Date.now();
        socket.broadcast.to(roomId).emit('play');
    });
    socket.on('pause', () => {
        rooms[roomId].playing = false;
        const now = Date.now() / 1000;
        rooms[roomId].timestamp += now - rooms[roomId].last_update;
        rooms[roomId].last_update = now;
        socket.broadcast.to(roomId).emit('pause');
    });
    socket.on('seek', data => {
        rooms[roomId].timestamp = data;
        rooms[roomId].last_update = Date.now();
        socket.broadcast.to(roomId).emit('seek', data);
    });
    socket.on('disconnect', () => {
        if (rooms[roomId] !== undefined) {
            rooms[roomId].participants = rooms[roomId].participants.filter(id => id !== clientId);
            if (rooms[roomId].participants.length === 0) {
                // If no clients are left in the room wait 30 seconds before deleting it finally
                setTimeout(() => {
                    if (rooms[roomId] !== undefined && rooms[roomId].participants.length === 0) {
                        rooms[roomId] = undefined;
                        delete rooms[roomId];
                    }
                }, 30 * 1000);
            } else {
                // Wait 5 seconds for the client to reconnect otherwise broadcast leave message
                setTimeout(() => {
                    if (rooms[roomId].participants.filter(id => id === clientId).length === 0) {
                        socket.broadcast.to(roomId).emit('participants', rooms[roomId].participants);
                    }
                }, 5 * 1000);
            }
        }
    });
});


console.log('Listening on *:8000');
