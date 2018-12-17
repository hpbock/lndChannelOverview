const fs = require('fs');
const grpc = require('grpc');
const lnrpc = grpc.load('rpc.proto').lnrpc;
const express = require('express');

const program = require('commander');
program
    .version('1.0.0', '-v, --version')
    .description('plot a sankey diagram of the forwarding history')
    .option('--lnd.macaroon [base64|path]', 'Base64 encoded string or path to macaroon', process.env.LND_MACAROON || '/root/.lnd/invoice.macaroon')
    .option('--lnd.rpccert [base64|path]', 'Base64 encoded string or path to TLS certificate for lnd\'s RPC services', process.env.LND_RPC_CERT || '/root/.lnd/tls.cert')
    .option('--lnd.rpcserver [server]', 'Interface/port to lnd\'s RPC services', process.env.LND_RPC_SERVER || 'localhost:10009')
    .option('--listen [server]', 'Interface/port to the web app', process.env.LISTEN || 'localhost:3000')
    .parse(process.argv)

let lndMacaroon
try {
    // try to get macaroon from path
    lndMacaroon = fs.readFileSync(program['lnd.macaroon']).toString('hex');
} catch (err) {
    // it's probably a base64 encoded string then
    lndMacaroon = Buffer.from(program['lnd.macaroon'], 'base64').toString('hex');
}

let lndCert
try {
    // try to get certificate from path
    lndCert = fs.readFileSync(program['lnd.rpccert'])
} catch (err) {
    // it's probably a base64 encoded string then
    lndCert = Buffer.from(program['lnd.rpccert'], 'base64')
}

process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA'
const sslCreds = grpc.credentials.createSsl(lndCert);
const macaroonCreds = grpc.credentials.createFromMetadataGenerator(function(args, callback) {
    var metadata = new grpc.Metadata()
    metadata.add('macaroon', lndMacaroon);
    callback(null, metadata);
});
const creds = grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds);
const lightning = new lnrpc.Lightning(program['lnd.rpcserver'], creds);

var ownNodeKey = "";

var request = {}
lightning.getInfo(request, function(err, response) {
    if (!err) {
        ownNodeKey = response.identity_pubkey;
        console.log("own node pubkey: " + ownNodeKey);
    } else {
        console.log(err);
    }
});

var app = express();
var server = require('http').createServer(app);

// app.use(express.static(__dirname + '/node_modules'));
app.get('/', function(req, res, next) {
    res.sendFile(__dirname + '/index.html');
});

app.get('/channels', function(req, res, next) {
    lightning.listChannels({}, function(err, response) {
        if (err) {
            res.send(500, { error: 'request failed' });
        } else {
            res.send(response);
        }
    })
});

server.listen(4202);