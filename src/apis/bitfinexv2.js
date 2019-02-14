const BFX = require('bitfinex-api-node');
const Order = require('bfx-api-node-models').Order;
const logger = require('../common/logger').logger;
const ApiInterface = require('./api');


class BitfinexApiv2 extends ApiInterface {
    /**
     * Set up the API
     * @param key
     * @param secret
     * @param margin
     * @param maxLeverage
     */
    constructor(key, secret, margin, maxLeverage) {
        super(key, secret);

        // Keep hold of the API key and secret
        this.key = key;
        this.secret = secret;
        this.isMargin = !!margin;
        this.maxLeverage = 1;
        if (maxLeverage && this.isMargin) {
            this.maxLeverage = maxLeverage > 3.33 ? 3.33 : maxLeverage;
        }

        this.bfx = new BFX({
            apiKey: key,
            apiSecret: secret,
            transform: true,
            ws: {
                autoReconnect: true,
                seqAudit: false,
            },
        });

        this.ws = this.bfx.ws();

        // cache of some data
        this.state = {
            ticker: [],
            wallet: [],
            walletUpdates: 0,
            walletTimer: null,
            orders: [],
        };
        this.symbols = [];
    }

    /**
     * Subscribe to all the events relating to a symbol that we want
     * @param symbol
     */
    subscribeSymbol(symbol) {
        const ws = this.ws;
        const eventFilter = { symbol: `t${symbol}` };

        // Every time the price changes, this happens.
        ws.onTicker(eventFilter, (ticker) => {
            const t = ticker.toJS();
            this.state.ticker = this.state.ticker.filter(item => item.symbol !== symbol);
            this.state.ticker.push({
                symbol,
                bid: String(t.bid),
                ask: String(t.ask),
                last_price: String(t.lastPrice),
            });
        });

        // handlers to track the state of ordes
        ws.onOrderSnapshot(eventFilter, (orders) => {
            logger.debug('order snapshot');
            this.onOrderSnapshot(orders);
        });

        ws.onOrderNew(eventFilter, (order) => {
            logger.debug(`New order seen - id:${order.id}`);
            this.onOrderUpdate(order);
            this.refreshAvailableFunds();
        });

        ws.onOrderUpdate(eventFilter, (order) => {
            logger.debug(`Order updated - id:${order.id}`);
            this.onOrderUpdate(order);
            this.refreshAvailableFunds();
        });

        ws.onOrderClose(eventFilter, (order) => {
            logger.debug(`Order closed - id:${order.id}`);
            this.onOrderUpdate(order);
            this.refreshAvailableFunds();
        });

        ws.subscribeTicker(`t${symbol}`);

        if (this.isMargin) {
            this.ws.requestCalc([`margin_sym_t${symbol}`]);
        }
    }

    /**
     * Open the socket connection and attaches handles to events we need to know about
     * @returns {Promise<any>}
     */
    init() {
        const self = this;
        const ws = self.ws;

        ws.on('error', (err) => {
            logger.error('Error detected on socket connection');
            logger.error(err);
        });

        ws.on('open', () => {
            logger.debug('socket opened');
            ws.auth();
        });

        ws.on('close', () => { logger.debug('socket closed'); });

        // Some handlers to track the state our of wallet
        ws.onWalletSnapshot({}, (wallet) => {
            logger.debug('wallet snapshot');
            self.onWalletUpdate(wallet);
            self.refreshAvailableFunds();
        });

        ws.onWalletUpdate({}, wallet => self.onWalletUpdate([wallet]));

        // Happens once when we are authenticated. We use this to complete set up
        ws.once('auth', () => {
            logger.progress(`bfx v2 API Authenticated - ${this.isMargin ? 'margin' : 'spot'}`);

            // subscribe to stuff?
            this.symbols.forEach((sym) => {
                this.subscribeSymbol(sym);
            });
        });

        // Open the socket and resolve when we are authed
        return new Promise((resolve) => {
            ws.once('auth', () => {
                // give it a little bit of time to settle.
                setTimeout(() => { resolve(); }, 1000);
            });

            // Now all the handlers are set up, open the connection
            ws.open();
        });
    }

    /**
     * Called when a new symbol is being added
     * @param symbol
     */
    async addSymbol(symbol) {
        logger.debug(`adding ${symbol}`);
        if (this.symbols.indexOf(symbol) >= 0) {
            return;
        }

        // add the symbol
        this.symbols.push(symbol);
        if (this.ws.isAuthenticated()) {
            this.subscribeSymbol(symbol);
        }

        // Wait for the ticker to be live
        let tries = 10;
        while (tries > 0 && this.state.ticker.findIndex(item => item.symbol === symbol) < 0) {
            logger.debug('waiting for ticker to be valid');
            await this.sleep(300);
            tries -= 1;
        }
    }

    /**
     * Close up the socket
     * @returns {Promise<void>}
     */
    async terminate() {
        try {
            logger.debug('Closing bitfinex websocket connection...');
            // chance for any last minute shutdown stuff
            await this.ws.close();
            this.ws = null;
        } catch (err) {
            logger.error('Error while trying to close sockets');
            logger.error(err);
        }
    }

    /**
     * Just wait for some milliseconds
     * @param ms
     * @returns {Promise<any>}
     */
    sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(() => { resolve(); }, ms);
        });
    }

    /**
     * Ask for the available balance to be updated.
     */
    refreshAvailableFunds() {
        this.state.walletUpdates = 0;
        clearTimeout(this.state.walletTimer);
        this.state.walletTimer = setTimeout(() => {
            this.symbols.forEach((symbol) => {
                const asset = symbol.substring(0, 3).toUpperCase();
                const currency = symbol.substring(3).toUpperCase();
                const walletType = (this.isMargin ? 'margin' : 'exchange');
                this.ws.requestCalc([`wallet_${walletType}_${asset}`, `wallet_${walletType}_${currency}`]);
            });
        }, 100);
    }

    /**
     * Called when we get a change to the wallet
     * @param wallet
     */
    onWalletUpdate(wallet) {
        const mapped = wallet.map(item => ({
            type: item.type,
            currency: item.currency.toLowerCase(),
            amount: String(item.balance),
            available: item.balanceAvailable === null ? String(item.balance * this.maxLeverage) : String(item.balanceAvailable * this.maxLeverage),
        })).filter(item => item.type === (this.isMargin ? 'margin' : 'exchange'));

        mapped.forEach((item) => {
            this.state.wallet = this.state.wallet.filter(w => w.currency !== item.currency);
            this.state.wallet.push(item);
        });

        this.state.walletUpdates += 1;
    }

    /**
     * Helper to remap from bfx raw to the data we use everywhere
     * @param orders
     * @returns {*}
     */
    orderRemap(orders) {
        return orders.map((order) => {
            const isCanceled = order.status === null ? false : order.status.includes('CANCELED');
            const isExecuted = order.status === null ? false : order.status.includes('EXECUTED');
            const isClosed = isExecuted || isCanceled;
            return {
                id: order.id,
                side: order.amountOrig > 0 ? 'buy' : 'sell',
                amount: Math.abs(order.amountOrig),
                remaining: Math.abs(order.amount),
                executed: Math.abs(order.amountOrig) - Math.abs(order.amount),
                price: order.price,
                status: order.status,
                type: order.type,
                flags: order.flags,
                is_filled: order.amount === 0,
                is_canceled: isCanceled,
                is_execited: isExecuted,
                is_open: !isClosed,
                last_updated: order.mtsUpdate === null ? Date.now() : order.mtsUpdate,
            };
        });
    }

    /**
     * Handles up snapshot of all orders
     * @param orders
     */
    onOrderSnapshot(orders) {
        this.state.orders = this.orderRemap(orders);
    }

    /**
     * Handles an change to one of the orders
     * @param order
     * @param replaceOnlyIfMissing
     */
    onOrderUpdate(order, replaceOnlyIfMissing = false) {
        const mapped = this.orderRemap([order.toJS()]).shift();

        if (replaceOnlyIfMissing) {
            const existing = this.state.orders.find(o => o.id === mapped.id);
            if (existing) {
                // ok, already had a matching entry, so use that instead.
                return existing;
            }
        }

        // remove an older version of this order
        this.state.orders = this.state.orders.filter(o => o.id !== mapped.id);

        // remember the new data
        this.state.orders.push(mapped);

        return mapped;
    }

    /**
     * Get the ticker for a symbol
     * @param symbol
     * @returns {*}
     */
    async ticker(symbol) {
        const index = this.state.ticker.findIndex(item => item.symbol === symbol);
        if (index < 0) {
            logger.error(this.state.ticker);
            throw new Error(`Unexpected symbol in ticker - looking for ${symbol}.`);
        }

        return this.state.ticker[index];
    }

    /**
     * Get the balances
     * @returns {*}
     */
    async walletBalances() {
        if (this.state.walletUpdates < 1) {
            await this.sleep(300);
        }
        return this.state.wallet;
    }

    /**
     * Creates a new order
     * @param symbol
     * @param amount
     * @param price
     * @param side
     * @param type
     * @param reduceOnly
     * @returns {Promise<*>}
     */
    async newOrder(symbol, amount, price, side, type, reduceOnly = false) {
        // Build new order
        const o = new Order({
            symbol: `t${symbol}`,
            price,
            amount: side === 'buy' ? amount : -amount,
            type,
        }, this.ws);

        if (reduceOnly) {
            o.setReduceOnly(true);
        }

        const bfxOrder = await o.submit();
        return this.onOrderUpdate(bfxOrder, true);
    }

    /**
     * place a limit order
     * @param symbol
     * @param amount
     * @param price
     * @param side
     * @param isEverything
     * @returns {*}
     */
    async limitOrder(symbol, amount, price, side, isEverything) {
        return this.newOrder(symbol, amount, price, side, this.isMargin ? Order.type.LIMIT : Order.type.EXCHANGE_LIMIT);
    }

    /**
     * Place a market order
     * @param symbol
     * @param amount
     * @param side - buy or sell
     * @param isEverything
     */
    async marketOrder(symbol, amount, side, isEverything) {
        return this.newOrder(symbol, amount, 0, side, this.isMargin ? Order.type.MARKET : Order.type.EXCHANGE_MARKET);
    }

    /**
     * Place a stop market order
     * @param symbol
     * @param amount
     * @param price
     * @param side
     * @param trigger - mark price, index price etc (not used on bfx)
     * @returns {Promise<void>}
     */
    async stopOrder(symbol, amount, price, side, trigger) {
        return this.newOrder(symbol, amount, price, side, this.isMargin ? Order.type.STOP : Order.type.EXCHANGE_STOP, this.isMargin);
    }

    /**
     * Cancel orders
     * @param orders - and array of orders to cancel
     * @returns {*}
     */
    cancelOrders(orders) {
        // Fire off all the cancels and collect up all the promises
        const pending = orders.map((order) => {
            const o = new Order({ id: order.id }, this.ws);
            return o.cancel();
        });

        // wait for all the promises to resolve.
        return Promise.all(pending);
    }

    /**
     * Get active orders
     * @param symbol
     * @param side - buy, sell or all
     * @returns {PromiseLike<T> | Promise<T>}
     */
    async activeOrders(symbol, side) {
        return this.state.orders.filter(order => ((side === 'buy' || side === 'sell') ? order.side === side : true));
    }

    /**
     * Get order info
     * @param orderInfo
     * @returns {PromiseLike<{id: *, side: *, amount: number, remaining: number, executed: number, is_filled: boolean}> | Promise<{id: *, side: *, amount: number, remaining: number, executed: number, is_filled: boolean}>}
     */
    async order(orderInfo) {
        return this.state.orders.filter(order => order.id === orderInfo.id).shift();
    }
}

module.exports = BitfinexApiv2;