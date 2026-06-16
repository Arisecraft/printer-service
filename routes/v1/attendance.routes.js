const express = require('express');
const  ZKLib  = require('node-zklib');

const attendanceRouter = express.Router();

// Device configuration
const DEVICE_IP = '192.168.0.201';
const DEVICE_PORT = 4370;

let zkInstance = null;

const executeZKCommand = async (actionCallback) => {
  let zk = null;
  try {
    // 1. Create a NEW instance for this specific request
    zk = new ZKLib(DEVICE_IP, DEVICE_PORT, 10000, 4000);

    // 2. Create Socket
    await zk.createSocket();
    
    // 3. Perform the action (getAttendances, getUsers, etc.)
    const result = await actionCallback(zk);

    // 4. Disconnect immediately after work is done
    await zk.disconnect();

    return result;
  } catch (error) {
    // Ensure we attempt to disconnect even if an error occurred
    if (zk) {
      try { await zk.disconnect(); } catch (e) { /* ignore disconnect error */ }
    }
    throw error;
  }
};

// GET /v1/attendance - Fetch all attendance logs
// attendanceRouter.get('/', async (req, res) => {
//   try {
//     const zk = await initializeDevice();

//     // Get attendance logs
//     const logs = await zk.getAttendances();

//     // Format the response
//     const formattedLogs = logs.map(log => ({
//       userId: log.userId,
//       timestamp: log.timestamp,
//       date: log.timestamp.toISOString().split('T')[0],
//       time: log.timestamp.toTimeString().split(' ')[0],
//       deviceId: log.deviceId || 'Unknown',
//       status: log.status || 'Check-In'
//     }));

//     res.json({
//       success: true,
//       device: {
//         ip: DEVICE_IP,
//         port: DEVICE_PORT
//       },
//       totalRecords: formattedLogs.length,
//       data: formattedLogs
//     });

//   } catch (error) {
//     console.error('Error fetching attendance:', error);
//     res.status(500).json({
//       success: false,
//       error: error.message,
//       device: {
//         ip: DEVICE_IP,
//         port: DEVICE_PORT
//       }
//     });
//   }
// });
// attendanceRouter.post('/', async (req, res) => {
//     const { from_date, to_date } = req.body;
//   try {
//     const logs = await executeZKCommand(async (zk) => {
//       // Get all logs
//       return await zk.getAttendances();
//     });

//      const from = new Date(from_date);
//     const to = new Date(to_date);

//      const filtered = logs.data.filter(log => {
//       const punchTime = new Date(log.recordTime);
//       return punchTime >= from && punchTime <= to;
//     });

//     console.log('Total attendance logs fetched:', filtered);

//     const formattedLogs = filtered.map(log => ({
//       userId: log.deviceUserId,
//       timestamp: log.recordTime,
//       date: new Date(log.recordTime).toISOString().split('T')[0],
//       time: new Date(log.recordTime).toTimeString().split(' ')[0],
//       deviceId: 'Essl-201',
//       status: 'Check-In'
//     }));

//     res.json({
//       success: true,
//       totalRecords: formattedLogs.length,
//       data: formattedLogs
//     });

//   } catch (error) {
//     console.error('Error fetching attendance:', error.message);
//     res.status(500).json({ success: false, error: 'Device connection error: ' + error.message });
//   }
// });

attendanceRouter.get('/', async (req, res) => {
  const { from_date, to_date } = req.query;

  if (!from_date || !to_date) {
    return res.status(400).json({ success: false, error: 'Please provide from_date and to_date' });
  }

  try {
    // 1. Fetch raw logs from device
    const logs = await executeZKCommand(async (zk) => {
      return await zk.getAttendances();
    });
  console.log(logs.data)
    // 2. Setup Date Boundaries
    // Set 'from' to beginning of day (00:00:00)
    const fromDate = new Date(from_date);
    fromDate.setHours(0, 0, 0, 0);

    // Set 'to' to END of day (23:59:59) to include records from that day
    const toDate = new Date(to_date);
    toDate.setHours(23, 59, 59, 999);

    // 3. Filter Logs
    // Note: Use 'logs.filter', not 'logs.data.filter'
    const filteredLogs = logs.data.filter(log => {
      // node-zklib usually uses 'recordDate' (check your console log if it's undefined)
      const punchTime = new Date( log.recordTime); 
      return punchTime >= fromDate && punchTime <= toDate;
    });

    console.log(`Logs found: ${logs.data.length} | After Filter: ${filteredLogs.length}`);

    // 4. Format with Timezone Fix (Asia/Kolkata)
    const formattedLogs = filteredLogs.map(log => {
      const dateObj = new Date(log.recordDate || log.recordTime);
      console.log('Original UTC Time:', dateObj.toISOString());
      console.log('India Time:', dateObj.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }));

      return {
        userId: log.deviceUserId,
        timestamp: dateObj, // Raw UTC
        date: dateObj.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
        time: dateObj.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }),
        deviceId: 'Essl-201',
        status: 'Check-In'
      };
    });

    res.json({
      success: true,
      totalRecords: formattedLogs.length,
      data: formattedLogs
    });

  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Device connection error: ' + (error.message || error) 
    });
  }
});


// GET /v1/attendance/users - Get all users from device
attendanceRouter.get('/users', async (req, res) => {
  try {
    const zk = await initializeDevice();

    // Get users
    const users = await zk.getUsers();

    // Format the response
    const formattedUsers = users.map(user => ({
      userId: user.userId,
      name: user.name || 'Unknown',
      role: user.role || 'User',
      cardNo: user.cardNo || null,
      password: user.password ? '****' : null, // Hide password in response
      groupId: user.groupId || null
    }));

    res.json({
      success: true,
      device: {
        ip: DEVICE_IP,
        port: DEVICE_PORT
      },
      totalUsers: formattedUsers.length,
      data: formattedUsers
    });

  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      device: {
        ip: DEVICE_IP,
        port: DEVICE_PORT
      }
    });
  }
});

// GET /v1/attendance/status - Get device status
attendanceRouter.get('/status', async (req, res) => {
  try {
    const zk = await initializeDevice();

    // Get device info
    const info = await zk.getInfo();

    res.json({
      success: true,
      device: {
        ip: DEVICE_IP,
        port: DEVICE_PORT,
        connected: true
      },
      info: info
    });

  } catch (error) {
    console.error('Error getting device status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      device: {
        ip: DEVICE_IP,
        port: DEVICE_PORT,
        connected: false
      }
    });
  }
});

// POST /v1/attendance/clear - Clear all attendance logs (use with caution)
attendanceRouter.post('/clear', async (req, res) => {
  try {
    const zk = await initializeDevice();

    // Clear attendance logs
    await zk.clearAttendanceLog();

    res.json({
      success: true,
      message: 'Attendance logs cleared successfully',
      device: {
        ip: DEVICE_IP,
        port: DEVICE_PORT
      }
    });

  } catch (error) {
    console.error('Error clearing attendance logs:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      device: {
        ip: DEVICE_IP,
        port: DEVICE_PORT
      }
    });
  }
});

// GET /v1/attendance/today - Get today's attendance
attendanceRouter.get('/today', async (req, res) => {
  try {
    const zk = await initializeDevice();

    // Get all attendance logs
    const logs = await zk.getAttendances();

    // Filter for today's date
    const today = new Date();
    const todayString = today.toISOString().split('T')[0];

    const todayLogs = logs
      .filter(log => log.timestamp.toISOString().split('T')[0] === todayString)
      .map(log => ({
        userId: log.userId,
        timestamp: log.timestamp,
        time: log.timestamp.toTimeString().split(' ')[0],
        deviceId: log.deviceId || 'Unknown',
        status: log.status || 'Check-In'
      }));

    res.json({
      success: true,
      device: {
        ip: DEVICE_IP,
        port: DEVICE_PORT
      },
      date: todayString,
      totalRecords: todayLogs.length,
      data: todayLogs
    });

  } catch (error) {
    console.error('Error fetching today\'s attendance:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      device: {
        ip: DEVICE_IP,
        port: DEVICE_PORT
      }
    });
  }
});

// Cleanup on process exit
process.on('SIGINT', async () => {
  if (zkInstance && zkInstance.isConnected) {
    try {
      await zkInstance.disconnect();
      console.log('Disconnected from ESSL device');
    } catch (error) {
      console.error('Error disconnecting from device:', error);
    }
  }
});

process.on('SIGTERM', async () => {
  if (zkInstance && zkInstance.isConnected) {
    try {
      await zkInstance.disconnect();
      console.log('Disconnected from ESSL device');
    } catch (error) {
      console.error('Error disconnecting from device:', error);
    }
  }
});

module.exports = attendanceRouter;
