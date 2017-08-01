const lookupManufacturer = require('flight-recorder-manufacturers/lookup');

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

/* tslint:disable:max-line-length */
const RE_A = /^A(\w{3})(\w{3,}?)(?:FLIGHT:(\d+)|\:(.+))?/;
const RE_HFDTE = /^HFDTE(\d{2})(\d{2})(\d{2})/;
const RE_PLT_HEADER = /^H[FO]PLT(?:.{0,}?:(.*)|(.*))$/;
const RE_CM2_HEADER = /^H[FOP]CM2(?:.{0,}?:(.*)|(.*))$/; // P is used by some broken Flarms
const RE_GTY_HEADER = /^H[FO]GTY(?:.{0,}?:(.*)|(.*))$/;
const RE_GID_HEADER = /^H[FO]GID(?:.{0,}?:(.*)|(.*))$/;
const RE_CID_HEADER = /^H[FO]CID(?:.{0,}?:(.*)|(.*))$/;
const RE_CCL_HEADER = /^H[FO]CCL(?:.{0,}?:(.*)|(.*))$/;
const RE_FTY_HEADER = /^H[FO]FTY(?:.{0,}?:(.*)|(.*))$/;
const RE_RFW_HEADER = /^H[FO]RFW(?:.{0,}?:(.*)|(.*))$/;
const RE_RHW_HEADER = /^H[FO]RHW(?:.{0,}?:(.*)|(.*))$/;
const RE_B = /^B(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})([NS])(\d{3})(\d{2})(\d{3})([EW])([AV])(-\d{4}|\d{5})(-\d{4}|\d{5})/;
const RE_I = /^I(\d{2})(?:\d{2}\d{2}[A-Z]{3})+/;
/* tslint:enable:max-line-length */

declare namespace IGCParser {
  export interface IGCFile {
    aRecord: ARecord;

    /** UTC date of the flight in ISO 8601 format */
    date: string;

    pilot: string | null;
    copilot: string | null;

    gliderType: string | null;
    registration: string | null;
    callsign: string | null;
    competitionClass: string | null;

    loggerType: string | null;
    firmwareVersion: string | null;
    hardwareVersion: string | null;

    fixes: BRecord[];
  }

  interface PartialIGCFile extends Partial<IGCFile> {
    fixes: BRecord[];
  }

  export interface ARecord {
    manufacturer: string;
    loggerId: string;
    numFlight: number | null;
    additionalData: string | null;
  }

  export interface BRecord {
    /** Unix timestamp of the GPF fix in milliseconds */
    timestamp: number;

    /** UTC time of the GPF fix in ISO 8601 format */
    time: string;

    latitude: number;
    longitude: number;
    valid: boolean;
    pressureAltitude: number | null;
    gpsAltitude: number | null;

    extensions: BRecordExtensions;

    fixAccuracy: number | null;

    /** Engine Noise Level from 0.0 to 1.0 */
    enl: number | null;
  }

  export interface BRecordExtensions {
    [code: string]: string;
  }

  export interface BRecordExtension {
    code: string;
    start: number;
    length: number;
  }
}

class IGCParser {
  private _result: IGCParser.PartialIGCFile = {
    pilot: null,
    copilot: null,
    gliderType: null,
    registration: null,
    callsign: null,
    competitionClass: null,
    loggerType: null,
    firmwareVersion: null,
    hardwareVersion: null,
    fixes: [],
  };

  private fixExtensions: IGCParser.BRecordExtension[];

  private lineNumber = 0;
  private prevTimestamp: number | null;

  static parse(str: string): IGCParser.IGCFile {
    let parser = new IGCParser();

    for (let line of str.split('\n')) {
      parser.processLine(line.trim());
    }

    return parser.result;
  }

  get result(): IGCParser.IGCFile {
    if (!this._result.aRecord) {
      throw new Error(`Missing A record`);
    }

    if (!this._result.date) {
      throw new Error(`Missing HFDTE record`);
    }

    return this._result as IGCParser.IGCFile;
  }

  private processLine(line: string) {
    this.lineNumber += 1;

    let recordType = line[0];

    if (recordType === 'B') {
      let fix = this.parseBRecord(line);

      this.prevTimestamp = fix.timestamp;

      this._result.fixes.push(fix);

    } else if (recordType === 'H') {
      this.processHeader(line);

    } else if (recordType === 'A') {
      this._result.aRecord = this.parseARecord(line);

    } else if (recordType === 'I') {
      this.fixExtensions = this.parseIRecord(line);
    }
  }

  private processHeader(line: string) {
    let headerType = line.slice(2, 5);
    if (headerType === 'DTE') {
      this._result.date = this.parseDateHeader(line);
    } else if (headerType === 'PLT') {
      this._result.pilot = this.parsePilot(line);
    } else if (headerType === 'CM2') {
      this._result.copilot = this.parseCopilot(line);
    } else if (headerType === 'GTY') {
      this._result.gliderType = this.parseGliderType(line);
    } else if (headerType === 'GID') {
      this._result.registration = this.parseRegistration(line);
    } else if (headerType === 'CID') {
      this._result.callsign = this.parseCallsign(line);
    } else if (headerType === 'CCL') {
      this._result.competitionClass = this.parseCompetitionClass(line);
    } else if (headerType === 'FTY') {
      this._result.loggerType = this.parseLoggerType(line);
    } else if (headerType === 'RFW') {
      this._result.firmwareVersion = this.parseFirmwareVersion(line);
    } else if (headerType === 'RHW') {
      this._result.hardwareVersion = this.parseHardwareVersion(line);
    }
  }

  private parseARecord(line: string): IGCParser.ARecord {
    let match = line.match(RE_A);
    if (!match) {
      throw new Error(`Invalid A record at line ${this.lineNumber}: ${line}`);
    }

    let manufacturer = lookupManufacturer(match[1]);
    let loggerId = match[2];
    let numFlight = match[3] ? parseInt(match[3], 10) : null;
    let additionalData = match[4] || null;

    return { manufacturer, loggerId, numFlight, additionalData };
  }

  private parseDateHeader(line: string): string {
    let match = line.match(RE_HFDTE);
    if (!match) {
      throw new Error(`Invalid DTE header at line ${this.lineNumber}: ${line}`);
    }

    let lastCentury = match[3][0] === '8' || match[3][0] === '9';
    return `${lastCentury ? '19' : '20'}${match[3]}-${match[2]}-${match[1]}`;
  }

  private parseTextHeader(headerType: string, regex: RegExp, line: string, underscoreReplacement = ' '): string {
    let match = line.match(regex);
    if (!match) {
      throw new Error(`Invalid ${headerType} header at line ${this.lineNumber}: ${line}`);
    }

    return (match[1] || match[2] || '').replace(/_/g, underscoreReplacement).trim();
  }

  private parsePilot(line: string): string {
    return this.parseTextHeader('PLT', RE_PLT_HEADER, line);
  }

  private parseCopilot(line: string): string {
    return this.parseTextHeader('CM2', RE_CM2_HEADER, line);
  }

  private parseGliderType(line: string): string {
    return this.parseTextHeader('GTY', RE_GTY_HEADER, line);
  }

  private parseRegistration(line: string): string {
    return this.parseTextHeader('GID', RE_GID_HEADER, line, '-');
  }

  private parseCallsign(line: string): string {
    return this.parseTextHeader('GTY', RE_CID_HEADER, line);
  }

  private parseCompetitionClass(line: string): string {
    return this.parseTextHeader('GID', RE_CCL_HEADER, line);
  }

  private parseLoggerType(line: string): string {
    return this.parseTextHeader('FTY', RE_FTY_HEADER, line);
  }

  private parseFirmwareVersion(line: string): string {
    return this.parseTextHeader('RFW', RE_RFW_HEADER, line);
  }

  private parseHardwareVersion(line: string): string {
    return this.parseTextHeader('RHW', RE_RHW_HEADER, line);
  }

  private parseBRecord(line: string): IGCParser.BRecord {
    if (!this._result.date) {
      throw new Error(`Missing HFDTE record before first B record`);
    }

    let match = line.match(RE_B);
    if (!match) {
      throw new Error(`Invalid B record at line ${this.lineNumber}: ${line}`);
    }

    let time = `${match[1]}:${match[2]}:${match[3]}`;

    let timestamp = Date.parse(`${this._result.date}T${time}Z`);

    // allow timestamps one hour before the previous timestamp,
    // otherwise we assume the next day is meant
    while (this.prevTimestamp && timestamp < this.prevTimestamp - ONE_HOUR) {
      timestamp += ONE_DAY;
    }

    let latitude = IGCParser.parseLatitude(match[4], match[5], match[6], match[7]);
    let longitude = IGCParser.parseLongitude(match[8], match[9], match[10], match[11]);

    let valid = match[12] === 'A';

    let pressureAltitude = match[13] === '00000' ? null : parseInt(match[13], 10);
    let gpsAltitude = match[14] === '00000' ? null : parseInt(match[14], 10);

    let extensions: IGCParser.BRecordExtensions = {};
    if (this.fixExtensions) {
      for (let { code, start, length } of this.fixExtensions) {
        extensions[code] = line.slice(start, start + length);
      }
    }

    let enl = null;
    if (extensions['ENL']) {
      let enlLength = this.fixExtensions.filter(it => it.code === 'ENL')[0].length;
      let enlMax = Math.pow(10, enlLength);

      enl = parseInt(extensions['ENL'], 10) / enlMax;
    }

    let fixAccuracy = extensions['FXA'] ? parseInt(extensions['FXA'], 10) : null;

    return {
      timestamp,
      time,
      latitude,
      longitude,
      valid,
      pressureAltitude,
      gpsAltitude,
      extensions,
      enl,
      fixAccuracy,
    };
  }

  private parseIRecord(line: string): IGCParser.BRecordExtension[] {
    let match = line.match(RE_I);
    if (!match) {
      throw new Error(`Invalid I record at line ${this.lineNumber}: ${line}`);
    }

    let num = parseInt(match[1], 10);
    if (line.length < 3 + num * 7) {
      throw new Error(`Invalid I record at line ${this.lineNumber}: ${line}`);
    }

    let extensions = new Array<IGCParser.BRecordExtension>(num);

    for (let i = 0; i < num; i++) {
      let offset = 3 + i * 7;
      let start = parseInt(line.slice(offset, offset + 2), 10);
      let end = parseInt(line.slice(offset + 2, offset + 4), 10);
      let length = end - start + 1;
      let code = line.slice(offset + 4, offset + 7);

      extensions[i] = { start, length, code };
    }

    return extensions;
  }

  private static parseLatitude(dd: string, mm: string, mmm: string, ns: string): number {
    let degrees = parseInt(dd, 10) + parseFloat(`${mm}.${mmm}`) / 60;
    return (ns === 'S') ? -degrees : degrees;
  }

  private static parseLongitude(ddd: string, mm: string, mmm: string, ew: string): number {
    let degrees = parseInt(ddd, 10) + parseFloat(`${mm}.${mmm}`) / 60;
    return (ew === 'W') ? -degrees : degrees;
  }
}

export = IGCParser;