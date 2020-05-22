// network = new Network(WebSocket || window.WebSocket || window.MozWebSocket)
// network.set_print(cc.log)
// network.set_delay(5)
// network.open_debug(true)
// network.connect('192.168.5.48', '8080')
// hall_echo = function() {}
// network.register('hall.echo', hall_echo)
// network.send_msg('hall.echo', {string: "123"})
// network.send_msg('hall.echo', {string: "123"}, hall_echo)

let msgpack = require("msgpack")

const NET_STATE = {
    CONNECTING : 0, // The connection is not yet open.
    OPEN       : 1, // The connection is open and ready to communicate.
    CLOSING    : 2, // The connection is in the process of closing.
    CLOSED     : 3  // The connection is closed or couldn't be opened.
}

const HEART_DELAY_TIME = 5
let get_send_string = function(that, cmd, ts, str) {
    let total = 0, charCode, i, len, back = []
    for (i = 0, len = str.length; i < len; i++) {
        charCode = str.charCodeAt(i)
        if (charCode <= 0x007f) {
            total += 1
            back.push(charCode)
        } else if (charCode <= 0x07ff) {
            total += 2
            back.push((192 | (31 & (charCode >> 6))))
            back.push((128 | (63 & charCode)))
        } else {
            total += 3
            back.push((224 | (15 & (charCode >> 12))));
            back.push((128 | (63 & (charCode >> 6))));
            back.push((128 | (63 & charCode)))
        }
    }
    for (i = 0; i < back.length; i++) {
        back[i] &= 0xff
    }
    if (that.DEBUG && that.print && cmd != 'hall.hello') {
        that.print('send_msg time:', ts, str, 'bytes:', total)
    }
    if (total <= 0xff) {
        return new Uint8Array([0, total].concat(back))
    } else {
        return new Uint8Array([total >> 8, total & 0xff].concat(back))
    }
}
let get_send_buffer = function(that, cmd, ts, buf) {
    let total = buf.byteLength
    if (that.DEBUG && that.print && cmd != 'hall.hello') {
        that.print('send_msg time:', ts, cmd, 'bytes:', total)
    }
    if (total <= 0xff) {
        return new Uint8Array([0, total].concat(Array.from(buf)))
    } else {
        return new Uint8Array([total >> 8, total & 0xff].concat(Array.from(buf)))
    }
}
let next_session = function(session_id) {
    if (session_id > 100 * 1000 * 1000) {
        session_id = 0
    }
    session_id = session_id + 1
    return session_id
}

let net = {
    ctor(WebSocket) {
        this.WebSocket = WebSocket
        this.session_id = 0
        this.heart_delay = HEART_DELAY_TIME
        this.handler = {}
        this.DEBUG = false
    },
    set_print(f) { this.print = f },
    set_delay(sec) {
        if (typeof(sec) != 'undefined' && sec > 0) {
            this.heart_delay = sec
        }
    },
    open_debug(b) { this.DEBUG = b },
    connect_host(addr, open_cb, close_cb) {
        let socket = new this.WebSocket(addr)
        socket.binaryType = "arraybuffer"
        socket.onopen = function(evt) {
            this.socket = socket
            this.begin_update = false
            this.cb_map = {}
            if (this.DEBUG && this.print) {
                this.print("WebSocket is open now.", this.socket)
            }
            if (typeof(open_cb) == 'function') {
                open_cb()
            }
        }.bind(this)
        socket.onmessage = function(evt) {
            this.dispatch(evt)
        }.bind(this)
        socket.onerror = function(evt) {
            if (this.DEBUG && this.print) {
                this.print("WebSocket error observed:", evt)
            }
            this.close()
        }.bind(this)
        socket.onclose = function(evt) {
            if (this.DEBUG && this.print) {
                this.print("WebSocket is closed now.")
            }
            this.ping_time = 0
            this.cb_map = {}
            if (typeof(close_cb) == 'function') {
                close_cb()
            }
        }.bind(this)
    },
    connect(host, port, cb, close_cb) {
        return this.connect_host('ws://' + host + ':' + port, cb, close_cb)
    },
    is_close() {
        if (this.socket) {
            if (this.socket.readyState == NET_STATE.OPEN || this.socket.readyState == NET_STATE.CONNECTING) {
                return false
            }
        }
        return true
    },
    set_ping(dt) {
        this.ping_time = dt + this.heart_delay
        this.last_pong_check = true
        this.begin_update = true
    },
    update(dt) {
        if (!this.socket) {
            return
        }
        if (!this.begin_update) {
            this.set_ping(dt)
            if (this.DEBUG && this.print) {
                this.print('set_ping', dt, this.ping_time)
            }
            return
        }
        if (typeof(this.ping_time) != 'undefined' && this.ping_time > 0) {
            if (dt >= this.ping_time) {
                if (!this.last_pong_check) {
                    this.ping_time = 0
                    if (this.DEBUG && this.print) {
                        this.print('last_pong_check failed', this.ping_time, dt)
                    }
                    this.close()
                } else {
                    this.ping_time = dt + this.heart_delay
                    this.send_msg('hall.hello', undefined, function(data) {
                        this.last_pong_check = true
                    }.bind(this))
                    this.last_pong_check = false
                }
            }
        }
    },
    send_msg(cmd, data, cb) {
        if (this.socket && this.socket.readyState == NET_STATE.OPEN) {
            let sid = next_session(this.session_id)
            this.session_id = sid
            let ts = Math.floor(Date.now() / 1000)
            let request = {
                session: sid,
                cmd: cmd,
                data: data || undefined,
                timestamp: ts
            }
            let chunk
            try {
                // chunk = JSON.stringify(request)
                chunk = msgpack.serialize(request)
            } catch (e) {
                if (this.DEBUG && this.print) {
                    this.print('stringify json err:', ts, request)
                }
                return false
            }
            // let buf = get_send_string(this, cmd, ts, chunk).buffer
            let buf = get_send_buffer(this, cmd, ts, chunk).buffer

            this.socket.send(buf)
            this.cb_map[sid] = cb || this.handler[cmd]
            return true
        }
    },
    close() {
        if (this.socket) {
            this.print('active close')
            this.socket.close()
            this.socket = null
        }
    },
    dispatch(evt) {
        let resp
        try {
            // resp = JSON.parse(evt.data)
            resp = msgpack.deserialize(new Uint8Array(evt.data))
        } catch (e) {
            if (this.DEBUG && this.print) {
                let ts = Math.floor(Date.now() / 1000)
                this.print('parse json err:', ts, evt)
            }
            return
        }
        if (this.DEBUG && this.print && resp.dump_cmd != 'hall.hello') {
            let ts = Math.floor(Date.now() / 1000)
            this.print('receive time:', ts, resp)
        }
        if (resp.session && this.cb_map[resp.session]) {
            this.cb_map[resp.session](resp.data)
        } else {
            if (resp.cmd && this.handler[resp.cmd]) {
                this.handler[resp.cmd](resp.data)
            }
        }
    },
    register(cmd, handler) {
        if (cmd && handler) {
            this.handler[cmd] = handler
        }
    }
}

export default net
