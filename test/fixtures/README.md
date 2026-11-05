# TLS test fixtures

`localhost-cert.pem` is a self-signed certificate for localhost and 127.0.0.1.
Its corresponding private key is deliberately public and is used only by local
test servers. These files must never be used for deployed services.

Interactive tunnel tests explicitly trust this certificate for their local TLS
proxy; application certificate verification remains enabled.
