const fs = require('fs');
const grpc = require('grpc');
const lnrpc = grpc.load('rpc.proto').lnrpc;
const express = require('express');
var bodyParser = require('body-parser');

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
app.use(bodyParser.json({ type: 'application/json' }));

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

app.get('/channelgraph', function(req, res, next) {
    lightning.describeGraph({}, function(err, response) {
        if (err) {
            res.send(500, { error: 'request failed' });
        } else {
            res.send(response);
        }
    })
});

function getOtherNode(thisNode, edge) {
    if (thisNode === edge.node1_pub) return edge.node2_pub;
    if (thisNode === edge.node2_pub) return edge.node1_pub;
    console.error(thisNode + " is neither " + edge.node1_pub + " neither " + edge.node2_pub + ".");
}

function getOtherNodesPolicy(thisNode, edge) {
    if (thisNode === edge.node1_pub) return edge.node2_policy;
    if (thisNode === edge.node2_pub) return edge.node1_policy;
    console.error(thisNode + " is neither " + edge.node1_pub + " neither " + edge.node2_pub + ".");
}

app.post('/chanids2route', function(req, res, next) {
    console.log(req.body);

    console.log("own node pubkey: " + ownNodeKey);

    let amount_msat = req.body.amount * 1000;
    let hops = req.body.hops;
    let node = ownNodeKey; // TODO this is incorrect - it should be read out of the last channel hop
    let route = { "hops": [] };
    let timeLockDelta = 0;
    let totalTimeLock = 0;
    while (0 < hops.length) {
        chanId = hops.pop();
        let edge = edges[chanId];
        let policy = getOtherNodesPolicy(node, edge);
        let fee_msat = Math.trunc(amount_msat * parseInt(policy.fee_rate_milli_msat) / 1000000 + parseInt(policy.fee_base_msat));
        let routehop = {
            "chan_id": chanId,
            "chan_capacity": edge.capacity,
            "amt_to_forward": Math.trunc(amount_msat / 1000),
            "fee": Math.trunc(fee_msat / 1000),
            "expiry": timeLockDelta,
            "amt_to_forward_msat": amount_msat,
            "fee_msat": fee_msat,
            "pub_key": node
        }
        route.hops.unshift(routehop);
        timeLockDelta = parseInt(policy.time_lock_delta);
        totalTimeLock += timeLockDelta;
        amount_msat += fee_msat;
        node = getOtherNode(node, edge);
    }
    route.total_fees_msat = Math.trunc(amount_msat - req.body.amount * 1000);
    route.total_amt_msat = amount_msat;
    route.total_time_lock = totalTimeLock;
    route.total_fees = Math.trunc(route.total_fees_msat / 1000);
    route.total_amt = Math.trunc(amount_msat / 1000);

    // fix time lock delta
    let blockHeight = 1000000; // TODO insert current blockheight here
    route.totalTimeLock += blockHeight;
    for (h of route.hops) {
        h.expiry += blockHeight;
    }

    res.status(200).send(route);
});

lightning.describeGraph({}, function(err, response) {
    if (err) {
        // nothing
    } else {
        edges = {};
        for (chan of response.edges) {
            edges[chan.channel_id] = chan;
        }
    }
});


server.listen(4202);