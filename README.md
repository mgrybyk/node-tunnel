## node-tunnel

> NodeJS port forwarding implementation

Allows you to open to forward any custom port (rdp, ssh, proxies, whatever) from machine in some private network (with no public ip) to another machine anywhere else through some server with public ip.

![](https://github.com/mgrybyk/node-tunnel/blob/images-only/imgs/client-server-agent.png?raw=true)

1. have Node.js 24 LTS or newer and npm
2. clone repo
3. npm ci

**WARN: data is NOT encrypted at the moment, except service messages!**

### tests

Run the automated unit and end-to-end suite with:

```sh
npm test
npm run test:coverage
```

The end-to-end test starts the real server, two agents, and six clients on
loopback ports. It runs 72 tunnel connections across three traffic waves, with
24 connections active in parallel per wave, and verifies binary responses byte
for byte. No external services are required.

Coverage includes the spawned server, agent, and client processes and enforces
minimum statement, line, function, and branch thresholds.


### server

install server on machine with public ip
create your own configuration in `.env` file, example:
```
N_T_SERVER_PORT=32121
N_T_SERVER_PORTS_FROM=32131
N_T_SERVER_PORTS_TO=32141
```
NOTE: ports specified should be accessible from internet

### agent

install agent on machine you want to connect to
create your own configuration in `.env` file, example:
```
N_T_SERVER_HOST=server-with-public-ip
N_T_SERVER_PORT=32121

N_T_AGENT_NAME=test-rdp
N_T_AGENT_DATA_HOST=localhost
N_T_AGENT_DATA_PORT=3389
```
or
```
N_T_SERVER_HOST=server-with-public-ip
N_T_SERVER_PORT=32121

N_T_AGENT_NAME=test-ssh
N_T_AGENT_DATA_HOST=some-machine
N_T_AGENT_DATA_PORT=22
```
It is better to use long client/agent names for security reasons!

### client

install client on your local machine
create your own configuration in `.env` file, example:
```
N_T_SERVER_HOST=server-with-public-ip
N_T_SERVER_PORT=32121

N_T_CLIENT_NAME=test-rdp
N_T_CLIENT_PORT=1111
```
or
```
N_T_SERVER_HOST=server-with-public-ip
N_T_SERVER_PORT=32121

N_T_CLIENT_NAME=test-ssh
N_T_CLIENT_PORT=1112
```


Finally, to open rdp/ssh connection to machine where agent is installed, connect to localhost:1111 / localhost:1112 with your rdp/ssh client correspondingly


*Client port (`N_T_CLIENT_PORT`) should not be accessible from outside because everyone will access data port opened by agent! 
If you still want/need it - feel free.*


### set service messages crypt key (not data!)

```
# exactly 32 UTF-8 bytes
N_T_CRYPT_KEY=:AKJSF-238fh;LASJFBH:3rf0=;hn:EW
```

`N_T_CRYPT_KEY` must be the same for the server, all agents, and all clients.
Message nonces are generated automatically; there is no IV setting.

### protocol compatibility

The server, agents, and clients must use the same protocol version. A mismatched
new client or agent logs the version error and exits. Legacy unframed peers are
closed after the handshake timeout and cannot connect to this release.

Optional reliability settings are:

```sh
N_T_RECONNECT_DELAY_MS=5000
N_T_HANDSHAKE_TIMEOUT_MS=10000
N_T_CONTROL_IDLE_TIMEOUT_MS=45000
```


### one more img example :)

![](https://github.com/mgrybyk/node-tunnel/blob/images-only/imgs/port-forwarding.png?raw=true)

---

**NOTE**: 

you can combine as you want server, agent, client instances. Example: you can have server and client on same machine with public ip.


*Client port (`N_T_CLIENT_PORT`) should not be accessible from outside because everyone will access data port opened by agent! 
If you still want/need it - feel free.*

---

## FAQ

**Q**: I have public IP according to my provider config, but agent can't connect to server.

**A**: Multiple issues possible, like: firewalls, your host is connected to router and no virtual server is configured for server ports, etc.

**Q**: I have multiple messages on client/agent side "Connection to server established."

**A**: Ensure every process uses the same `N_T_CRYPT_KEY` and protocol version.

## security

The remaining known security limitations are tracked in [SECURITY.md](SECURITY.md).
