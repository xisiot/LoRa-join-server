'use strict';

const chai = require('chai');
chai.use(require('chai-json-schema-ajv'));
const expect = chai.expect;
const assert = chai.assert;
const mocha = require('mocha');
const crypto = require('crypto');
const path = require('path');
const join = path.join.bind(undefined, '../../../../');
const { consts, Log, dbClient, Models, utils } = require(join('lib/lora-lib'));
const reverse = utils.bufferReverse;
const config = require(join('config'));
const logger = new Log(config.log, 'test');
const buf2str = utils.buf2str;
const mochaConfig = config.mocha;
const bitwiseAssigner = utils.bitwiseAssigner;

const dbClients = {
  RedisClient: dbClient.createRedisClient(config.database.redis),
  MySQLClient: dbClient.createSequelizeClient(config.database.mysql),
};

const modelIns = {
  RedisModel: {},
  MySQLModel: {},
};

modelIns.RedisModel.MQTTTopics = new Models.RedisModels.MQTTTopics(dbClients.RedisClient);

for (let model in Models.MySQLModels) {
  modelIns.MySQLModel[model] = new Models.MySQLModels[model](dbClients.MySQLClient);
}

const JoinHandler = require(join('lib/joinHandler'));

const didReg = new RegExp(/^D[0-9a-fA-F]{21}$/);

const appInfo = {
  JoinEUI: Buffer.alloc(consts.JOINEUI_LEN),
  userID: 'testUser',
  name: 'test',
};

const appQuery = {
  JoinEUI: appInfo.JoinEUI,
};

const deviceInfo = {
  DevEUI: crypto.randomBytes(consts.DEVEUI_LEN),
  JoinEUI: appInfo.JoinEUI,
};

const deviceQuery = {
  DevEUI: deviceInfo.DevEUI,
};

const testJoinReq = {
  RejoinType: Buffer.from('00','hex'),
  JoinEUI: appInfo.JoinEUI,
  DevEUI: deviceInfo.DevEUI,
  NwkID: Buffer.alloc(consts.NWKID_LEN),
  NetID: Buffer.alloc(consts.NETID_LEN),
  DevNonce: crypto.randomBytes(consts.DEVNONCE_LEN),
};

const mhdr = Buffer.alloc(consts.MHDR_LEN); // All zero
const AppKey = crypto.randomBytes(consts.APPKEY_LEN);
const NwkKey = crypto.randomBytes(consts.NWKKEY_LEN);

// const testJoinReqPHYPayload = {
//   MACPayload: testJoinReq,
//   MHDR: mhdr,
//   MIC: JoinHandler.joinMICCalculator({
//     MHDR: mhdr,
//     JoinEUI: testJoinReq.JoinEUI,
//     DevEUI: testJoinReq.DevEUI,
//     DevNonce: testJoinReq.DevNonce,
//   }, AppKey, 'request'),
// };

const devRegOpts = {
  mac: buf2str(testJoinReq.DevEUI, 1),
  product_key: buf2str(testJoinReq.JoinEUI),
  passcode: buf2str(testJoinReq.DevNonce, 1),
};

const DLSettingsPackager = (RX1DRoffset, RX2DR) => {
  const OptNeg = 1;
  let DLSettings = Buffer.alloc(consts.DLSETTINGS_LEN);
  DLSettings = bitwiseAssigner(DLSettings, consts.OPTNEG_OFFSET, consts.OPTNEG_LEN, OptNeg);
  DLSettings = bitwiseAssigner(
    DLSettings,
    consts.RX1DROFFSET_OFFSET,
    consts.RX1DROFFSET_LEN,
    RX1DRoffset
  );
  DLSettings = bitwiseAssigner(
    DLSettings,
    consts.RX2DR_OFFSET,
    consts.RX2DR_LEN,
    RX2DR
  );
  return DLSettings;
};

const RxDelayPackager = (RxDelay, delay) => bitwiseAssigner(
  RxDelay,
  consts.RXDELAY_BITOFFSET,
  consts.RXDELAY_BITLEN,
  delay
);

describe('Test join', () => {
  let testJoinHdl;
  let DevAddr;
  let AppInfo = modelIns.MySQLModel.AppInfo;
  let DeviceInfo = modelIns.MySQLModel.DeviceInfo;
  let DLSettings;
  let RxDelay;

  const JoinNonce = crypto.randomBytes(consts.JOINNONCE_LEN);
  deviceInfo.AppKey = AppKey;
  deviceInfo.NwkKey = NwkKey;
  before('Get connection with MySQL', (done) => {
    testJoinHdl = new JoinHandler(modelIns, config, logger);
    DLSettings = DLSettingsPackager(4, 0);
    RxDelay = Buffer.alloc(1);
    RxDelay = RxDelayPackager(RxDelay, 1);
    DevAddr = JoinHandler.genDevAddr(appInfo.JoinEUI,
      testJoinReq.DevEUI,
      testJoinReq.NwkID
    );
    AppInfo
      .createItem(appInfo)
      .then(() => {
        return DeviceInfo
          .createItem(deviceInfo);
      })
      .then(() => {
        done();
      })
      .catch((err) => {
        done(err);
      });
  });

  describe('Test generation of DevAddr', () => {
    it('DevAddr should be Buffer and 4 Bytes long', () => {
      expect(Buffer.isBuffer(DevAddr)).to.be.true;
      expect(DevAddr).to.have.lengthOf(consts.DEVADDR_LEN);
    });
  });

  describe('Test generation of session keys', () => {
    let nonce = {
      DevNonce: testJoinReq.DevNonce,
      JoinNonce: JoinNonce,
      JoinEUI:appInfo.JoinEUI,
      DevEUI:testJoinReq.DevEUI,
    };
    it('Generate Session Key', () => {
      let AppSKey = JoinHandler.genSKey(AppKey, nonce,'APP');
      let JSIntKey = JoinHandler.genSKey(NwkKey, nonce,'JSINT');
      let SNwkSIntKey = JoinHandler.genSKey(NwkKey, nonce, 'SNWKSINT');
      console.log(AppSKey);
      console.log(JSIntKey);
      console.log(SNwkSIntKey);
      expect(Buffer.isBuffer(SNwkSIntKey)).to.be.true;
      expect(SNwkSIntKey.length).to.equal(consts.SNWKSINTKEY_LEN);
    });
  });

  describe('Test generation of Join Accept', () => {
    let joinAcpt;
    before('Generate join accept message', () => {
      testJoinHdl.DevAddr = DevAddr;
      testJoinHdl.JoinNonce = JoinNonce;
      testJoinHdl.AppKey = AppKey;
      joinAcpt = testJoinHdl.genAcpt(testJoinReq, DLSettings, RxDelay);
    });

    it('join accept should conform to the schema', () => {
      //expect(joinAcpt).to.be.jsonSchema(jaSchema);
    });
  });

  describe('Test handler', () => {
    it('handler expect to return join accept params', (done) => {
      const testMHDR = Buffer.from('00', 'hex');
      const testMACPayload = {
        JoinEUI:testJoinReq.JoinEUI,
        DevEUI:testJoinReq.DevEUI,
        DevNonce:testJoinReq.DevNonce,
      };
      //const testMIC = Buffer.from(testJoinReqPHYPayload.MIC);
      let testJoinReqPHY = {
        MHDRRaw: testMHDR,
        MHDR: testMHDR,
        MACPayload: testMACPayload,
        // MIC: testMIC
      };
      testJoinReqPHY = {
        data: testJoinReqPHY,
        freq: 433,
      };
      testJoinHdl.handler(testJoinReqPHY)
        .then((joinPHYPayload) => {
          //expect(joinAcpt).to.be.jsonSchema(jaSchema);
          done();
        })
        .catch((err) => {
          done(err);
        });
    }).timeout(mochaConfig.timeout);

    it('Data should be stored in MySQL', (done) => {
      DeviceInfo
        .readItem(deviceQuery)
        .then((dev) => {
          expect(dev).not.to.be.null;
          return DeviceInfo.removeItem(deviceQuery);
        })
        .then(() => {
          done();
        })
        .catch((err) => {
          DeviceInfo.removeItem(deviceQuery);
          done(err);
        });
    });

    after('Close connection with MySQL', (done) => {
      AppInfo
        .removeItem(appQuery)
        .then(() => {
          dbClients.RedisClient.quit();
          dbClients.MySQLClient.close();
          done();
        });
    });
  });
});
