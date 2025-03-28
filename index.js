const zmq = require('zeromq');
const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const EventEmitter = require('events');

// Event emitters for communication between components
const serverToClientEmitter = new EventEmitter();
const clientToServerEmitter = new EventEmitter();

class WebSocketServer {
    constructor(port, certPath, keyPath) {
      this.port = port;
      this.clients = new Set();
      this.server = this.createServer(certPath, keyPath);
    }
    createServer(certPath, keyPath) {
        const httpsServer = https.createServer({
            cert: fs.readFileSync(certPath),
            key: fs.readFileSync(keyPath)
        });
  
        const wss = new WebSocket.Server({ server: httpsServer });
  
        wss.on('connection', (ws) => this.handleConnection(ws));
        httpsServer.listen(this.port);
  
        return wss;
    }
  
    handleConnection(ws) {
        const openTime = Date.now();
        this.clients.add(ws);
  
        // Send welcome message
        this.sendToClient(ws, {
            type: "welcome",
            data: "Connected to MT5 data stream"
        });
  
        ws.on('message', (message) => this.handleMessage(ws, message));
        ws.on('close', () => this.clients.delete(ws));
  
        console.log(`[${openTime}] WebSocket connection opened`);
    }
  
    handleMessage(ws, message) {
        try {
            const { type, data } = JSON.parse(message);
            switch(type) {
                case "request_data_from_mt5":
                    clientToServerEmitter.emit('switch_symbol', data);
                    break;
                case "request_historical":
                    const { ticker } = data;
                    const sanitizedTicker = ticker.replace(/\./g, '_');
                    const historicalData = mt5AlgoClass.getHistoricalMetrics(ticker, sanitizedTicker);
                    this.sendToClient(ws, {
                        type: "historical_data",
                        data: historicalData
                    });
                    break;
                case "request_current":
                    const currentData = mt5AlgoClass.getCurrentMetrics(data.ticker);
                    this.sendToClient(ws, {
                        type: "current_data",
                        data: currentData
                    });
                    break;
                case "request_all_volatility":
                    const volScores = mt5AlgoClass.getAllCurrentVolatilityScores();
                    this.sendToClient(ws, {
                        type: "all_volatility",
                        data: volScores
                    });
                    break;
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    }
  
    sendToClient(ws, data) {
        try {
            ws.send(JSON.stringify(data));
        } catch (error) {
            console.error('Error sending to client:', error);
        }
    }
  
    broadcastToAll(data) {
        for (const client of this.clients) {
            this.sendToClient(client, data);
        }
    }
}
  
// ZMQ Configuration
const ZMQ_CONFIG = {
    HOST: 'localhost',
    SYSTEM_PORT: 2201,
    DATA_PORT: 2202,
    LIVE_PORT: 2203
};

//todo:
//all_historical_kline (max 15 candle)
//all_historical_spreads 

class ZMQClient extends EventEmitter {
    constructor () {
        super()
        this.systemSocket = new zmq.Request();
        this.dataSocket = new zmq.Pull();
        this.isConnected = false;
        this.isSubscribed = false;
        // Start the receive loop
        this._startReceiveLoop();

        //metric related global var
        this.specData = {}
        this.getSpecData() //one time fn for zmq query, subsequent query get from locally
        .then(()=>{
            this.getHistoricalCandles()
        })
        

        //kline data used for metric calculation
        this.klineData = {}
        //spread data used for metric calculation
        this.spreadSpeedSCore = {}
        this.atrPercScore = {}
        this.amplitudePercScore = {}
        this.minDrawDownPenaltyScore = {} 
        this.avgSpreadScore = {} //dynamic
        this.volatilityScore = {} //dynamic


        //10 sec interval for metric data processing 
        //and sending the processed data to client interval
        this.intervalFn(10000) 
    }
    //metrics related
    getPriceAmplitudeScore(ticker) {
        // For each 5m candle, analyze its five 1m candles
        const kline = this.klineData[ticker];
        let totalAmplitude = ((Math.abs(kline[kline.length-15].o - kline[kline.length-1].c)) / kline[kline.length-15].o) * 100
        return totalAmplitude;
    }
    getHistoricalAtr(perpKline) {
        const period = 14;
        const klineLength = perpKline.length;
    
        // Calculate true ranges first
        const trueRanges = [];
    
        // Start from the earliest needed candle
        for (let i = 1; i < klineLength; i++) {
            const currentCandle = perpKline[i];
            const previousCandle = perpKline[i - 1];
        
            const highLowDiff = Math.abs(currentCandle.high - currentCandle.low);
            const highPrevCloseDiff = Math.abs(currentCandle.high - previousCandle.close);
            const lowPrevCloseDiff = Math.abs(currentCandle.low - previousCandle.close);
        
            const trueRange = Math.max(highLowDiff, highPrevCloseDiff, lowPrevCloseDiff);
            trueRanges.push(trueRange);
        }
    
        // Initialize first ATR using simple average of first 14 periods
        let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
    
        // Apply Wilder's smoothing formula for remaining periods
        for (let i = period; i < trueRanges.length; i++) {
            atr = ((atr * (period - 1)) + trueRanges[i]) / period;
        }
    
        // Express as percentage of current price using the last completed candle's close
        const lastCompleteCandle = perpKline[klineLength - 2];
        const atrPercentage = (atr / lastCompleteCandle.close) * 100;
    
        return { atrPercentage, previousAtr: atr };
    }
    histKlineHandler(ticker, histKlineObj){
        if(!this.atrPercScore[ticker]){
            this.atrPercScore[ticker] = {}
        }
        if(!this.klineData[ticker]){
            this.klineData[ticker] = histKlineObj
            //calculate atr score
            const { atrPercentage, previousAtr } = this.getHistoricalAtr(this.klineData[ticker])
            console.log(ticker, atrPercentage, previousAtr)
            return
            this.atrPercScore[ticker] = {atrPercentage,previousAtr}
    
            //calculate amplitude score inside the lookback period
            this.amplitudePercScore[ticker] = this.getPriceAmplitudeScore(ticker)
    
            //get vol score (not really useful during scoring)
            this.volumeScore[ticker] = this.getVolScore(ticker)
    
            //get the min drawdown in %
            const lastKline = this.klineData[ticker][this.klineData[ticker].length-1];
            const lastClose = lastKline.c;
            const minStopLoss = this.tickerSpecsData[ticker].stops_level;
            const digits = this.tickerSpecsData[ticker].digits;
            const pointSize = Math.pow(10, -digits);  // For 1 digit, this gives 0.1
            const minStopLossPoints = minStopLoss * pointSize;
            const minStopLossPrice = lastClose - minStopLossPoints;
            
            // Calculate percentage difference
            const minDrawdownPercentage = ((lastClose - minStopLossPrice) / lastClose) * 100;
    
            // Allow up to 3x ATR before penalizing
            const penaltyFactor = Math.min(3, atrPercentage/minDrawdownPercentage);
    
            this.minDrawDownPenaltyScore[ticker] = {
            minStopLossPoints,
            minDrawdownPercentage,
            penaltyFactor
            }
            // console.log(ticker, 'atr: ', atrPercentage , 'amplitude score: ', this.amplitudePercScore[ticker] , 'penalty' ,penaltyFactor)
    
            //amplitude score will be used to sort between trending market vs crabbing market (not part of the score)
        }

    }
    async intervalFn(interval){
        const padding = interval/4 
        const runFunction = async () => {
            const now = Date.now()
            const nextInterval = Math.ceil((now+padding) / interval) * interval;
            const remainingTime = nextInterval - now;
            const nextTimeout = Math.min(remainingTime, interval - 1);
            setTimeout(runFunction, nextTimeout)

            //interval logic


        }
        //kick start runFunction
        const now = Date.now();
        const nextInterval = Math.ceil((now) / interval) * interval
        let initialTimeout = nextInterval - now;
        setTimeout(runFunction, initialTimeout)
    }

    async _startReceiveLoop() {
      while (true) {
          try {
            const [msg] = await this.dataSocket.receive();
            const readableMsg = JSON.parse(msg.toString())

            if (this.isSubscribed && readableMsg?.status === 'subscribed') {
                this.emit('tickData',readableMsg);
            }
            else if(readableMsg?.action === 'FULL_KLINE'){
                this.emit('fullKline',readableMsg)
            }
            else if(readableMsg?.action === 'INSTRUMENT_SPECS') {
                readableMsg.data.forEach(specs => {
                    this.specData[specs.symbol] = specs;
                });
                //dont need to emit this. i have a helper fn getSpecData() that i can get from var anytime
            }
            //metrics below
            else if (readableMsg?.action === 'HISTORICAL_CANDLES') {
                const klineArrayRes = readableMsg.data
                for(let i = 0; i<klineArrayRes.length; i++){
                    const ticker = klineArrayRes[i].symbol
                    this.histKlineHandler(ticker, klineArrayRes[i].candles)
                } 
            }
            else if(readableMsg?.action === 'ALL_LIVE_CANDLES') {
                const klineArrayRes = readableMsg.data
                for(let i = 0; i<klineArrayRes.length; i++){
                    const ticker = klineArrayRes[i].symbol
                    this.klineData[ticker] = klineArrayRes[i].candles
                }
            }
            else if (readableMsg?.action === 'HISTORICAL_SPREADS') {
                console.log(readableMsg)
                const fromTime = readableMsg.fromTime
                const toTime = readableMsg.toTime
                const dataArray = readableMsg['']
                for(const histSpread in dataArray){
                    const histSpreadData = dataArray[histSpread]
                    const ticker = histSpreadData.name
                    const histSpreadArray = histSpreadData['']
                    // console.log(ticker,histSpreadArray)
                }
            
                // this.historicalSpreads = readableMsg.data;
            }
          } catch (error) {
              console.error('Error in receive loop:', error);
          }
      }
    }
    async connect() {
        try {
            await this.systemSocket.connect(`tcp://${ZMQ_CONFIG.HOST}:${ZMQ_CONFIG.SYSTEM_PORT}`);
            await this.dataSocket.connect(`tcp://${ZMQ_CONFIG.HOST}:${ZMQ_CONFIG.DATA_PORT}`);
            this.isConnected = true;
            console.log('ZMQ Client connected successfully');
        } catch (error) {
            console.error('Failed to connect ZMQ client:', error);
            throw error;
        }
    }
    async sendAndReceive(message) {
        try {
            // Send the initial message
            await this.systemSocket.send(JSON.stringify(message));
            
            // Wait for acknowledgment
            const [ackResponse] = await this.systemSocket.receive();
            const ack = ackResponse.toString();
            return { ack };
        } catch (error) {
            console.error('Error in sendAndReceive:', error);
            throw error;
        }
    }
    async changeSymbol(newSymbol) {
        const response = await this.sendAndReceive({
            action: 'CHANGE_SYMBOL',
            symbol: newSymbol
        });
    }
    //tickdata
    async subscribe(shouldSubscribe = true) {
        const response = await this.sendAndReceive({
            action: 'SUBSCRIBE',
            subscribe: shouldSubscribe
        });
        if (response.ack === 'OK') {
            this.isSubscribed = shouldSubscribe;
            return response.data;
        } else {
            throw new Error(`Subscription operation failed: ${response.ack.message}`);
        }
    }
    //specdata
    async getSpecData(ticker = null){
        if(ticker && this.specData[ticker]){
            return this.specData[ticker]
        }
        else if(!ticker && Object.keys(this.specData).length > 0){
            return this.specData
        }
        else if(!ticker && Object.keys(this.specData).length === 0){
            const response = await this.sendAndReceive({
                action:'INSTRUMENT_SPECS',
            })
        }
    }
    async getFullKlineForFE(ticker,tf){
        try{
            //todo add timeframe
            const response = await this.sendAndReceive({
                action: 'GET_FULL_KLINE_FOR_SYMBOL',
                symbol:ticker,
                timeframe:tf, 
            });
        } catch (error) {
            console.error('Error getting historical candles:', error);
            throw error;
        }
    }
    async getHistoricalCandles() {
        try {
            const response = await this.sendAndReceive({
                action: 'GET_HISTORICAL_CANDLES'
            });
        } catch (error) {
            console.error('Error getting historical candles:', error);
            throw error;
        }
    }
    async getAllLiveCandles(){
        try{
            const response = await this.sendAndReceive({
                action: 'GET_ALL_LIVE_CANDLES'
            });
        } catch (error) {
            console.error('Error getting historical candles:', error);
            throw error;
        }
    }
    async getHistoricalSpreads() {
        try {
            const response = await this.sendAndReceive({
                action: 'GET_HISTORICAL_SPREADS'
            });
        } catch (error) {
            console.error('Error getting historical spreads:', error);
            throw error;
        }
    }
}


const processTickData = (data) => {
    try {
        const parsedData = JSON.parse(data);

        const tickTime = parsedData.time
        // Convert to KST explicitly
        const now = Date.now()
        //latency ~200 . time it takes from korea -> mt5 broker server

    } catch (error) {
    console.error('Error processing tick data:', error);
    }
}
const processSpecData = (data) => {
    try {
        console.log('parsed spec data:', data)
    } catch (error) {
    console.error('Error processing tick data:', error);
    }
}

async function main() {
  try {
      // Initialize ZMQ client
      const zmqClient = new ZMQClient();
      await zmqClient.connect();

      // Initialize WebSocket server
      const wsServer = new WebSocketServer(3001, 
          "desktop-rb3jcvu.tail8a383a.ts.net.crt",
          "desktop-rb3jcvu.tail8a383a.ts.net.key"
      );

      // Set up event listeners
      clientToServerEmitter.on('switch_symbol', async (data) => {
          try {
              const { ticker } = data;
              await zmqClient.changeSymbol(ticker);
          } catch (error) {
              console.error('Error switching symbol:', error);
          }
      });

      // Initial setup
      
      zmqClient.on('tickData', (data) => {
            //stream tick data 
          processTickData(data);
      });
      zmqClient.on('fullKline', (data)=>{
        //stream this data once
      })
      zmqClient.on('specData', (data)=>{
        //stream this data once to fe client
        processSpecData(data);
      })


      // Start listening for ZMQ data

      // await zmqClient.subscribe(false);
      // await new Promise(r => setTimeout(r, 2000));
      // await zmqClient.changeSymbol('BTCUSD.mcf');
      // await new Promise(r => setTimeout(r, 2000));
      // await new Promise(r => setTimeout(r, 2000));
        //  await zmqClient.getFullKlineForFE('BTCUSD.mcf', 'm1') // can be m1, m3, m5, m15, m30, h1, h4, d1, w1, mn1  
    //   await zmqClient.getHistoricalSpreads()
        // await zmqClient.getAllLiveCandles()
      
      // await zmqClient.subscribe(true);
      // await new Promise(r => setTimeout(r, 2000));
      // await zmqClient.subscribe(false);



  } catch (error) {
      console.error('Application startup error:', error);
      process.exit(1);
  }
}

main().catch(console.error);