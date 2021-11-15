"use strict";

const LineByLineReader = require('line-by-line');
const fs = require("fs");
const moment = require("moment");

const queryTimingsCSVFilename = "query-timings-mysql.csv";
const connectionsCSVFilename = "connections-mysql.csv";

/**
 * Google sheets allows a maximum of 50k characters in a cell.
 */
const MAX_CELL_STRING_LENGTH = 50000;

async function slowLogAnalyzer() {
  const firstArg = process.argv[2];
  if ((process.argv.length < 3 || process.argv.length > 4)
    || firstArg === "-h"
    || firstArg === "--help"
    || firstArg === "-?") {
    console.log("\nMySQL Slow Log Analyzer help:\n\n");
    console.log("node slowLogAnalyzer.js [--cloudwatch-format] <filename-of-slow-query-log.log>");
    process.exit(1);
  }

  let cloudwatchFormat = firstArg === "--cloudwatch-format";
  let filename;
  if (cloudwatchFormat) {
    filename = process.argv[3];
  } else {
    filename = firstArg;
  }
  console.log(`Reading ${filename}...`);

  const lineReader = new LineByLineReader(filename);

  let queryToTimingsMap = new Map();

  let currentTiming = {count: 1, query: ""};
  let linesReadSoFar = 0;
  let startTime = Date.now();
  lineReader.on("error", error => {
    console.error("Error:", error);
  })
  lineReader.on("line", line => {
    lineReader.pause();
    linesReadSoFar++;
    if (linesReadSoFar % 10000 === 0) {
      const timeSoFar = (Date.now() - startTime) / 1000;
      console.log(`${linesReadSoFar.toLocaleString()} lines read so far. Unique queries found: ${queryToTimingsMap.size.toLocaleString()}. Time taken: ${timeSoFar.toFixed(3).toLocaleString()}s`);
      startTime = Date.now();
    }

    if (cloudwatchFormat ? line.includes("# Time:") : line.startsWith("# Time:")) {
      // Commit this query to the map
      let query = currentTiming.query;
      if (query) {
        query = cleanUpQuery(query);
        if (queryToTimingsMap.has(query)) {
          let queryTiming = queryToTimingsMap.get(query);
          queryTiming.totalTime += currentTiming.queryTime + currentTiming.lockTime;
          queryTiming.queryTime += currentTiming.queryTime;
          queryTiming.lockTime += currentTiming.lockTime;
          queryTiming.count += 1;
        } else {
          currentTiming.totalTime = currentTiming.queryTime + currentTiming.lockTime;
          currentTiming.query = query;
          queryToTimingsMap.set(query, currentTiming);
        }
      }

      // Reset everything
      currentTiming = {count: 1, query: ""};
    } else if (line.startsWith("# Query_time")) {
      const match = line.match(/# Query_time: ([0-9.]+) +Lock_time: ([0-9.]+) +Rows_sent: ([0-9.]+) +Rows_examined: ([0-9.]+)/);
      currentTiming.queryTime = parseFloat(match[1]);
      currentTiming.lockTime = parseFloat(match[2]);
    } else if (line.startsWith("SET timestamp=")) {
      const match = line.match(/SET timestamp=([0-9]+)/);
      currentTiming.unixTimestamp = parseInt(match[1]);
    } else if (line.startsWith("# Thread_id:")) {
      const match = line.match(/# Thread_id: *([0-9]+)/);
      currentTiming.connectionId = parseInt(match[1]);
    } else if (line.startsWith("# User@Host")) {
      const match = line.match(/# User@Host: .* Id: *([0-9]+)/);
      currentTiming.connectionId = parseInt(match[1]);
    } else if (line.startsWith("#")
      || line.startsWith("Tcp port:")
      || line.startsWith("use ")
      || line.startsWith("/* ")
      || line.startsWith("/rdsdbbin")
      || line.startsWith("@timestamp,@message")
      || line.startsWith("Time         ")) {
      // Ignore
    } else {
      currentTiming.query += line;
    }
    lineReader.resume();
  });

  lineReader.on("end", () => {
    writeTimingsCSV(queryToTimingsMap);
    writeConnectionsCSV(queryToTimingsMap);
  });
}

function cleanUpQuery(query) {
  let cleanQuery = query;
  // Convert all numbers to ?
  cleanQuery = cleanQuery.replace(/[-+]?[0-9]*\.?[0-9]+/g, "?");

  // Convert all strings to ?
  cleanQuery = cleanQuery.replace(/'[^']*'/g, "?");

  // Remove trailing double quotes
  if(cleanQuery.endsWith("\"")) {
    cleanQuery = cleanQuery.substring(0, cleanQuery.length-2);
  }
  return cleanQuery;
}

function writeTimingsCSV(queryToTimingsMap) {
  console.log("Writing timings to " + queryTimingsCSVFilename);
  let wstream = fs.createWriteStream(queryTimingsCSVFilename, {encoding: "utf8"});
  wstream.write(`"Total Time","Total Query Time","Total Lock Time","Average Time","Count","Query"\n`);

  // Arrange the data
  const values = queryToTimingsMap.values();
  const sortedByTime = Array.from(values).sort((v1, v2) => v2.totalTime - v1.totalTime);

  // Write to the CSV file
  for (const timing of sortedByTime) {
    wstream.write(`${timing.totalTime},${timing.queryTime},${timing.lockTime},${timing.totalTime / timing.count},${timing.count},"${cleanStringForCSV(timing.query)}"\n`);
  }
  wstream.end();
}

/**
 * This function make sure that Google Sheets/Excel can read the text.
 */
function cleanStringForCSV(someText) {
  let returnVal = someText.replace(/"/g, '""');
  return returnVal.length > MAX_CELL_STRING_LENGTH ?
    returnVal.substring(0, MAX_CELL_STRING_LENGTH - 3) + "..." :
    returnVal;
}

function writeConnectionsCSV(queryToTimingsMap) {
  console.log("Writing connections to " + connectionsCSVFilename);
  let wstream = fs.createWriteStream(connectionsCSVFilename, {encoding: "utf8"});

  // Arrange the data
  let values = queryToTimingsMap.values();
  values = Array.from(values);
  const timestampToQueriesMap = new Map();
  for (const value of values) {
    if (timestampToQueriesMap.has(value.unixTimestamp)) {
      const queries = timestampToQueriesMap.get(value.unixTimestamp);
      queries.push(value.query);
    } else {
      timestampToQueriesMap.set(value.unixTimestamp, [value.query]);
    }
  }
  const timings = Array.from(timestampToQueriesMap.keys()).map(timestamp => {
    let queries = timestampToQueriesMap.get(timestamp);
    return {
      unixTimestamp: timestamp,
      count: queries.length,
      queries: queries,
    };
  });
  const sortedByTime = timings.sort((v1, v2) => v1.unixTimestamp - v2.unixTimestamp);

  // Write to the CSV file
  wstream.write(`"Time","Connection Count","Queries"\n`);
  for (const timing of sortedByTime) {
    wstream.write(`${moment.unix(timing.unixTimestamp).format("YYYY-MM-DD HH:mm:ss")},${timing.count},"${cleanStringForCSV(timing.queries.join("\n"))}"\n`);
  }
  wstream.end();
}

slowLogAnalyzer();
