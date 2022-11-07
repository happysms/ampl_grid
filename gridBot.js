let config = require('./config');
let ccxt = require('ccxt');
const maria = require("mysql");


const conn = maria.createConnection({
    host: config.HOST,
    port: config.PORT,
    user: config.USER,
    password: config.PASSWORD,
    database: config.DATABASE
});

conn.connect(function(err) {
    if (err) throw err;
    console.log("Connected!");
    conn.query(`CREATE TABLE IF NOT EXISTS grid_record (
                datetime TIMESTAMP PRIMARY KEY,
                price DOUBLE,
                size DOUBLE,
                usd DOUBLE,
                side VARCHAR(255)
            )`,
        function (err, result) {
            if (err) throw err;
            console.log("Database created");
        }
    )
});

let insertRecord = async (price, size, usd, side) => {
    let sql = `INSERT INTO grid_record (price, size, usd, side) VALUES (${price}, ${size}, ${usd}, ${side})`;
    await conn.query(sql, function (err, result) {
        if (err) {
            conn.connect();
            let sql = `INSERT INTO grid_record (price, size, usd, side) VALUES (${price}, ${size}, ${usd}, ${side})`;
            conn.query(sql, function (err, result) {
                if (err) {
                    process.exit(0);
                }
            });
        }
        console.log(`${Date.now()} record inserted`);
    });
}


let getGridList = (lowerPrice, upperPrice, middlePrice, gridNum) => {
    let gridList = [];
    let halfGridNum = gridNum / 2;

    for (let i = 1; i < halfGridNum + 1; i++) {
        let gridPrice = middlePrice - i * (middlePrice - lowerPrice) / halfGridNum;
        gridPrice = parseFloat(gridPrice.toFixed(4));
        let gridSize = parseInt(((1 / gridPrice) * 200) / 10 + 1) * 10
        gridList.push([gridPrice, gridSize]);
    }

    gridList.push([middlePrice, parseInt(((1 / middlePrice) * 200) / 10 + 1) * 10]);

    for (let i = 1; i < halfGridNum + 1; i++) {
        let gridPrice = middlePrice + i * (upperPrice - middlePrice) / halfGridNum;
        gridPrice = parseFloat(gridPrice.toFixed(4));
        let gridSize = parseInt(((1 / gridPrice) * 200) / 10 + 1) * 10;
        gridList.push([gridPrice, gridSize]);
    }
    return gridList;
}


let getOrderSize = (price) => {
    if (price > config.MIDDLE_PRICE) {
        var gridSize = parseInt(((1 / price) * 200) / 10 + 1) * 10
    } else if (price < config.MIDDLE_PRICE) {
        var gridSize = parseInt(((1 / price) * 200) / 10 + 1) * 10
    } else {
        var gridSize = parseInt(((1 / config.MIDDLE_PRICE) * 200) / 10 + 1) * 10
    }
    return gridSize;
}


(async function () {
    let exchange = new ccxt.ftx({
        'apiKey': config.API_KEY,
        'secret': config.SECRET_KEY
    });
    let ticker = await exchange.fetchTicker(config.SYMBOL);
    let buyOrders = [];
    let sellOrders = [];

    // let initialBuyOrder = exchange.createMarketBuyOrder(config.SYMBOL, config.POSITION_SIZE * config.NUM_SELL_GRID_LINES);
    let gridList = getGridList(config.LOWER_PRICE, config.UPPER_PRICE, config.MIDDLE_PRICE, config.GRID_NUM);
    let gridPriceList = [];

    let minDifference = 1e9;
    let nearPrice = 0;

    for (let [gridPrice, size] of gridList) {
        let difference = Math.abs(gridPrice - ticker['bid']);
        if (minDifference > difference) {
            minDifference = difference;
            nearPrice = gridPrice
        }
        gridPriceList.push(gridPrice);
    }
    gridPriceList.sort();

    for (const [gridPrice, size] of gridList) {
        if (nearPrice === gridPrice) {
            if (nearPrice < ticker['bid']) {
                let order = await exchange.createLimitBuyOrder(config.SYMBOL, 10.0, gridPrice);
                buyOrders.push(order['info']);
            } else {
                let order = await exchange.createLimitSellOrder(config.SYMBOL, 10.0, gridPrice);
                sellOrders.push(order['info']);
            }
        } else if (ticker['bid'] < gridPrice) {
            console.log(`submitting market limit sell order at ${gridPrice}`);
            let order = await exchange.createLimitSellOrder(config.SYMBOL, parseFloat(size), gridPrice);
            sellOrders.push(order['info']);
        }
        else {
            console.log(`submitting market limit buy order at ${gridPrice}`);
            let order = await exchange.createLimitBuyOrder(config.SYMBOL, parseFloat(size), gridPrice);
            buyOrders.push(order['info']);
        }
    }

    while (true) {
        let closedOrderIds = [];
        for (let buyOrder of buyOrders) {
            console.log(`checking buy order ${buyOrder['id']}`);

            try {
                var order = await exchange.fetchOrder(buyOrder['id']);
            } catch (error) {
                console.log("request failed: ", error);
            }

            let orderInfo = order['info'];

            if (orderInfo['status'] === config.CLOSED_ORDER_STATUS) {
                closedOrderIds.push(orderInfo['id']);

                console.log(`buy order executed at ${orderInfo['price']}`);
                let idx = gridPriceList.indexOf(orderInfo['price'], 0);
                idx = idx + 1;
                let newSellPrice = gridPriceList[idx];
                let size = getOrderSize(newSellPrice);

                await insertRecord(orderInfo['price'], gridList[idx][0], gridList[idx][1], "buy");
                console.log(`creating new limit sell order at ${newSellPrice}`);
                let newSellOrder = await exchange.createLimitSellOrder(config.SYMBOL, size, newSellPrice);
                sellOrders.push(newSellOrder);
            }

            await new Promise(resolve => setTimeout(resolve, config.CHECK_ORDERS_FREQUENCY));
        }

        for (let sellOrder of sellOrders) {
            console.log(`checking sell order ${sellOrder['id']}`);

            try {
                var order = await exchange.fetchOrder(sellOrder['id']);
            } catch (error){
                console.log("request failed: ", error);
            }

            let orderInfo = order['info'];
            if (orderInfo['status'] === config.CLOSED_ORDER_STATUS) {
                closedOrderIds.push(orderInfo['id']);
                console.log(`sell order executed at ${orderInfo['price']}`);
                let idx = gridPriceList.indexOf(orderInfo['price'], 0);
                idx = idx - 1;
                let newBuyPrice = gridPriceList[idx];
                let size = getOrderSize(newBuyPrice);

                await insertRecord(orderInfo['price'], gridList[idx][0], gridList[idx][1], "sell");

                console.log(`creating new limit buy order at ${newBuyPrice}`);
                let newBuyOrder = await exchange.createLimitBuyOrder(config.SYMBOL, size, newBuyPrice);
                buyOrders.push(newBuyOrder);
            }
            let temp = await new Promise(resolve => setTimeout(resolve, config.CHECK_ORDERS_FREQUENCY));
            console.log(temp);
        }

        closedOrderIds.forEach(closedOrderId => {
            buyOrders = buyOrders.filter(buyOrder => buyOrder['id'] !== closedOrderId);
            sellOrders = sellOrders.filter(sellOrder => sellOrder['id'] !== closedOrderId);
        });

        if (sellOrders.length === 0) {
            console.log("nothing left to sell, exiting");
            process.exit(1);
        }

        console.log("loop end")
    }
})();