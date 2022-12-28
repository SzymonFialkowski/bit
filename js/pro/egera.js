'use strict';

//  ---------------------------------------------------------------------------

const egeraRest = require ('../egera');

//  ---------------------------------------------------------------------------

module.exports = class egera extends egeraRest {
    describe () {
        return this.deepExtend (super.describe (), {
            'validateServerSsl': false,
            'urls': {
                'api': {
                    'ws': 'wss://n1.ws.egera.com',
                },
            },
            'has': {
                'ws': true,
                'watchBalance': true,
                'watchTicker': true,
            },
            'options': {
                'requestId': {},
            },
            'requiredCredentials': {
                'secret': true,
            },
            'streaming': {
                // kucoin does not support built-in ws protocol-level ping-pong
                // instead it requires a custom json-based text ping-pong
                // https://docs.kucoin.com/#ping
                'ping': this.ping,
            },
        });
    }

    async initWS () {
        const url = this.urls['api']['ws'];
        const message = {
            'op': 'unsubscribe',
            'headers': { 'id': this.uid, 'token': this.secret },
            'args': [ 'trades:all', 'tickers:all', 'orderbooks:all', 'connected:all', 'balances:all', 'orders:all', 'wallets:all' ],
            //      trades: [ 'all', 'BTC_PLN', 'LTC_PLN', 'BTC_USD' ],
            //     tickers: [ 'BTC_PLN', 'LTC_PLN', 'all', 'BTC_USD' ],
            //     orderbooks: [ 'all', 'BTC_PLN', 'LTC_PLN', 'BTC_USD' ],
            //     connected: [ 'all' ],
            //     balances: [ 'all', 'BTC' ],
            //     orders: [ 'all' ],
            //     wallets: [ 'all' ],
            //     executions
        };
        const messageHash = 'disableAll';
        await this.watch (url, messageHash, message, messageHash);
    }

    requestId (url) {
        const options = this.safeValue (this.options, 'requestId', {});
        const previousValue = this.safeInteger (options, url, 0);
        const newValue = this.sum (previousValue, 1);
        this.options['requestId'][url] = newValue;
        return newValue;
    }

    async unsubscribe (topic, messageHash, method, symbol, params = {}) {
        const nonce = this.requestId ();
        const url = this.urls['api']['ws'];
        const subscribe = {
            'op': 'unsubscribe',
            'headers': { 'id': this.uid, 'token': this.secret },
            'args': [ 'trades:all', 'tickers:all', 'orderbooks:all' ],
        };
        const subscription = {
            'id': nonce.toString (),
            'symbol': symbol,
            'topic': topic,
            'messageHash': messageHash,
            'method': method,
        };
        const request = this.extend (subscribe, params);
        const subscriptionHash = messageHash;
        return await this.watch (url, messageHash, request, subscriptionHash, subscription);
    }

    async watchBalance () {
        await this.loadMarkets ();
        const topic = 'balances:all';
        return await this.subscribe (topic, undefined, {});
    }

    async watchTicker (symbol) {
        await this.loadMarkets ();
        // const topic = {
        //     action: 'tickers',
        //     symbol,
        // };
        const egeraSymbol = this.market (symbol)['id'].toUpperCase ();
        const topic = `tickers:${egeraSymbol}`;
        return await this.subscribe (topic, undefined, {});
    }

    async subscribe (topic, method, params = {}) {
        const nonce = this.requestId ();
        const url = this.urls['api']['ws'];
        const subscribe = {
            'op': 'subscribe',
            'headers': { 'id': this.uid, 'token': this.secret },
            'args': topic,
        };
        const messageHash = topic;
        const subscriptionHash = topic;
        const subscription = {
            'id': nonce.toString (),
            'symbol': topic.split (':')[1],
            'topic': topic,
            'messageHash': messageHash,
            // 'method': method,
        };
        const request = this.extend (subscribe, params);
        // console.log(url, messageHash, request, subscriptionHash, subscription)
        return await this.watch (url, messageHash, request, subscriptionHash, subscription);
    }

    handleBalanceMessage (client, message) {
        const id = this.safeString (message, 'id');
        const subscriptionsById = this.indexBy (client.subscriptions, 'id');
        const subscription = this.safeValue (subscriptionsById, id, {});
        const method = this.safeValue (subscription, 'method');
        if (method !== undefined) {
            method.call (this, client, message, subscription);
        }
        return message;
    }

    handleSubscriptionStatus (client, message) {
        console.log (',', message);
        //
        //     {
        //         id: '1578090438322',
        //         type: 'ack'
        //     }
        //
        const id = this.safeString (message, 'id');
        console.log ('11: ', id);
        const subscriptionsById = this.indexBy (client.subscriptions, 'id');
        console.log (subscriptionsById);
        const subscription = this.safeValue (subscriptionsById, id, {});
        console.log (subscription);
        const method = this.safeValue (subscription, 'method');
        console.log (method);
        if (method !== undefined) {
            method.call (this, client, message, subscription);
        }
        return message;
    }

    ping (client) {
        const id = this.requestId ().toString ();
        return {
            'id': id,
            'type': 'ping',
        };
    }

    handlePong (client, message) {
        // https://docs.kucoin.com/#ping
        client.lastPong = this.milliseconds ();
        return message;
    }

    handleTicker (client, message) {
        // message:
        // {
        //   action: 'ticker',
        //   symbol: 'ETH_PLN',
        //   last: '5218.18',
        //   volume: '0.00585214',
        //   change: '0.00 %'
        // }

        const marketId = this.safeString (message, 'symbol');
        let market = undefined;
        market = this.safeMarket (marketId, market, '_');
        const symbol = this.safeString (market, 'symbol');
        message['bid'] = message['last'];
        message['ask'] = message['last'];
        const ticker = this.parseTicker (message, market);
        this.tickers[symbol] = ticker;
        const messageHash = `tickers:${marketId}`;
        if (messageHash !== undefined) {
            return client.resolve (ticker, messageHash);
        }
        return message;
    }

    handleBalance (client, message) {
        console.log ('---', message);
        const currencyId = this.safeString (message, 'symbol');
        const messageHash = `balances:${currencyId}`;
        const currencyCode = this.safeCurrencyCode (currencyId);
        const value = this.safeValue (message, 'value', {});
        const account = this.account ();
        const result = {
            'info': message,
        };
        account['free'] = this.safeFloat (value, 'active');
        account['used'] = this.safeFloat (value, 'inactive');
        account['total'] = account['free'] + account['used'];
        result[currencyCode] = account;
        const balance = this.safeBalance (result);
        console.log (balance);
        if (messageHash !== undefined) {
            return client.resolve (balance, messageHash);
        }
        return message;
    }

    handleMessage (client, message) {
        const methods = {
            'ticker': this.handleTicker,
            'balance': this.handleBalance,
        };
        const event = this.safeString (message, 'action');
        const method = this.safeValue (methods, event);
        if (method === undefined) {
            const requestId = this.safeString (message, 'id');
            if (requestId !== undefined) {
                return this.handleSubscriptionStatus (client, message);
            }
            // if (event === undefined) {
            //     this.handleTicker (client, message);
            // }
        } else {
            const res = method.call (this, client, message);
            return res;
        }
    }
};
