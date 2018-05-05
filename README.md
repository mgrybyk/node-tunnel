## node-tunnel

nodejs implemention for port forwardning.

Allows you to open to forward any custom port (rdp, ssh, proxies, whatever) from machine in some private network (with no public ip) to another machine anywhere else through some server with public ip.

![](imgs/client-server-agent.png?raw=true)

0. have latest nodejs (8+) and npm
1. clone repo
2. npm i

**WARN: data is NOT encrpyted at the moment, except service messages!**


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
*It is better to use long client/agent names for security reasons!*


Finally, to open rdp/ssh connection to machine where agent is installed, connect to localhost:1111 / localhost:1112 with your rdp/ssh client correspondingly


*Client port (`N_T_CLIENT_PORT`) should not be accessible from outside because everyone will access data port opened by agent! 
If you still want/need it - feel free.*


### set service messages crypt key (not data!)

All service messages are encrypted with default key using **aes128**. To change override default key edit `.env.` file:
```
N_T_CRYPT_KEY=YOUR_ENCRYPTION_KEY
```
N_T_CRYPT_KEY should be the same for server, all agents and clients.


### data encryption  (not implemented yet)

TODO.
Currently having problems with buffer length. Once message is encrypted its length increases and single socket message splits to two (or more?) messages. Can't find out the way to join them back properly :(

### one more img example :)

![](imgs/port-forwarding.png?raw=true)

---

**NOTE**: 

you can combine as you want server, agent, client instances. Example: you can have server and client on same machine with public ip.


*Client port (`N_T_CLIENT_PORT`) should not be accessible from outside because everyone will access data port opened by agent! 
If you still want/need it - feel free.*

---

## FAQ

**Q**: I have public IP according to my provider config, but agent can't connect to server.

**A**: Multiple issues possible, like: firewalls, your host is connected to router and no virtual server is configured for server ports, etc.

**Q**: I have no server with public IP, what should I do?

**A**: You can create any instance where it is possible to run Node.js and open at least two ports, example: https://aws.amazon.com/free/

**Q**: I have multiple messages on client/agent side "Connection to server established."

**A**: You have to set same *N_T_CRYPT_KEY* for server and all agents/clients.

**Q**: Next plans?

**A**: fix defects, cleanup code, increase secuirty, your suggestions :).
