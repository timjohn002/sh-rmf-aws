// Callback examples from Keenon Cloud API Development Document V2.4.0, Appendix 1.
// Copied as published, minus the stray spaces the PDF puts inside some keys.
// Also used by the local end-to-end script (scripts/keenon-mock.ts).

export const KEENON_CALLBACK_FIXTURES = {
  // 4.1 Remote call callback
  CreateTask: {
    bizType: 'CreateTask',
    clientId: 'tianmao',
    data: {
      taskNo: 'demoData',
      taskStatus: 1,
      errorCode: 1,
      remark: 'demoData',
      deviceId: 'demoData',
      taskData: {
        remainingDistance: 1,
        robotSn: 'demoData',
        waitQueuing: 1,
        remainingWaitTime: 1,
        lastUpdateTime: '2022-02-02 12:22:22',
      },
    },
  },
  // 4.2 Machine presence
  RobotOnlineStatus: {
    bizType: ' RobotOnlineStatus ',
    clientId: ' tianmao ',
    data: { onlineStatus: false, robotSn: '8C:FC:A0:17:EF:C0' },
  },
  // 4.3 Machine online mode
  RobotOnlineType: {
    bizType: ' RobotOnlineType ',
    clientId: ' tianmao ',
    data: { onlineType: ' Wi-Fi ', robotSn: '0C:C6:55:77:32:84' },
  },
  // 4.4 Machine power information
  RobotPowerInfo: {
    bizType: ' RobotPowerInfo ',
    clientId: ' tianmao ',
    data: { robotSn: '0C:C6:55:77:32:84', power: { chargeStatus: -1, batteryLevel: 95 } },
  },
  // 4.5 Remote dispatch order status (pushed WITHOUT bizType/clientId)
  HotelOrderStatus: {
    orderNo: '20221229213425091',
    orderStatus: 100,
    logisticsList: [{ logisticsNo: '20221229213425612', cabin: 1, cabinType: 1, logisticsStatus: 501 }],
  },
  // 4.6 Robot delivery task (pushed WITHOUT bizType/clientId)
  HotelRobotBizTask: {
    taskState: 0,
    totalTime: 35.105,
    startTime: 1672312116669,
    storeName: '测试门店',
    endTime: 1672312151774,
    robotSn: '8C:18:D9:9D:D0:FA',
    storeId: 'S00003434',
    totalMileage: 0.0,
    uuid: 'fd28f36b533141d896933d2e07930619',
    taskDetails: [
      {
        duration: 0.0,
        logisticsNo: '20221229190829593',
        startTime: 1672312153948,
        endTime: 0,
        doorId: -1,
        takeCode: '1111',
        mileage: 0.0,
        status: 4,
        taskId: 12344,
        parentTaskId: 12345,
        reason: 301,
        taskType: '12',
      },
    ],
  },
  // 4.7 Working status / callable status
  RobotWorkState: {
    bizType: ' RobotWorkState ',
    clientId: 'tianmao',
    data: { robotSn: ' 54:EF:33:CA:E4:FF ', robotState: 2, canBeCalled: true },
  },
  // 4.8 Coordinate position and nearby point (example as printed: no bizType, no robotSn)
  RobotPositionType: {
    msg: 'Request successful',
    code: 610000,
    data: {
      robotPos: { x: '1.23', y: '-2.34', rotation: '35' },
      params: { dstId: 1, dstName: '桌号 3', dstType: '出菜口', distance: 1.23 },
    },
  },
  // 4.9 Remote task real-time status (example as printed: data only)
  RobotTaskState: {
    robotSn: '54:EF:33:CA:E4:FF',
    taskNo: 'ZdpbzvSLehGMAZ5h',
    taskNoType: 1,
    taskState: 3,
    taskType: 1,
    errorCode: 400,
    extendedInfo: '',
    subTaskInfoList: [
      { uuid: 'e23rt5ty', pointId: 2, pointName: '桌号 1', type: 1, taskState: 1, taskDistance: '12.3' },
      { uuid: 'y2ftt5er', pointId: 3, pointName: '桌号 3', type: 2, taskState: 1, taskDistance: '12.3' },
    ],
  },
  // 4.10 Cleaning robot real-time status (example as printed: no bizType)
  CleanRobotStatus: {
    globalState: {
      rosConnect: true,
      faulting: false,
      upgrading: false,
      locationSuc: true,
      scheduling: false,
      lock: false,
      scram: true,
    },
    hardwareState: { bilgeTankState: -1, dustBag: 1, rollingBrushPushRod: 0, armrests: 1, cleanWaterTank: -1 },
    subState: 21,
    mainState: 2,
    childState: { lifting: false, navigating: false },
    updateTime: 1736228801348,
    robotSn: '2C:C3:E6:E8:33:78',
  },
  // 4.11–4.17 Cleaning command receipts
  CleanRobotRechargeTask: { bizType: 'CleanRobotRechargeTask', code: 610000, robotSn: '2C:C3:E6:E8:33:78' },
  CleanRobotFinishTask: { bizType: 'CleanRobotFinishTask', code: 610000, robotSn: '2C:C3:E6:E8:33:78' },
  CleanRobotPauseTask: { bizType: ' CleanRobotPauseTask ', code: 610000, robotSn: '2C:C3:E6:E8:33:78' },
  CleanStrategyTemporary: { bizType: ' CleanStrategyTemporary ', code: 610000, robotSn: '2C:C3:E6:E8:33:78' },
  AddCleanStrategy: { bizType: ' AddCleanStrategy ', code: 610000, robotSn: '2C:C3:E6:E8:33:78' },
  UpdateCleanStrategy: { bizType: ' UpdateCleanStrategy ', code: 610000, robotSn: '2C:C3:E6:E8:33:78' },
  DeleteCleanStrategy: { bizType: ' DeleteCleanStrategy ', code: 610000, robotSn: '2C:C3:E6:E8:33:78' },
  // 4.18 Elevator riding
  openAdapt: {
    bizType: 'openAdapt',
    clientId: 'XLX12341243444',
    data: {
      action: 'QueryElevatorGroup',
      data: { dstId: 2, sourceFloorNum: 1, targetFloorNum: 11 },
      taskNo: '1237412342',
      messageId: 1569812313003,
      deviceName: '20:F4:1B:DD:2D:3F',
    },
  },
} as const

export type KeenonFixtureName = keyof typeof KEENON_CALLBACK_FIXTURES
