## node-tunnel

nodejs implemention for port forwardning.

Allows you to open to forward any custom port (rdp, ssh, proxies, whatever) from machine in some private network (with no public ip) to another machine anywhere else through some server with public ip.

![](port-forwarding.png?raw=true)

0. have latest nodejs (8+) and npm
1. clone repo
2. npm i

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
N_T_SERVER_HOST=your-server-hostname-or-ip
N_T_SERVER_PORT=32121

N_T_AGENT_NAME=test-rdp
N_T_AGENT_DATA_HOST=localhost
N_T_AGENT_DATA_PORT=3389
```
or
```
N_T_SERVER_HOST=your-server-hostname-or-ip
N_T_SERVER_PORT=32121

N_T_AGENT_NAME=test-ssh
N_T_AGENT_DATA_HOST=some-machine
N_T_AGENT_DATA_PORT=22
```

### client

install client on your local machine
create your own configuration in `.env` file, example:
```
N_T_SERVER_HOST=your-server-hostname-or-ip
N_T_SERVER_PORT=32121

N_T_CLIENT_NAME=test-rdp
N_T_CLIENT_PORT=1111
```
or
```
N_T_SERVER_HOST=your-server-hostname-or-ip
N_T_SERVER_PORT=32121

N_T_CLIENT_NAME=test-ssh
N_T_CLIENT_PORT=1112
```

finally, to open rdp/ssh connection to machine where agent is installed, connect to localhost:1111 / localhost:1112 with your rdp/ssh client correspondingly

---

NOTE: 
you can combine as you want server, agent, client instances. Example: you can have server and client on same machine with public ip.
