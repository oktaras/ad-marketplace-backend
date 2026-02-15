import {
    Cell,
    Slice,
    Address,
    Builder,
    beginCell,
    ComputeError,
    TupleItem,
    TupleReader,
    Dictionary,
    contractAddress,
    address,
    ContractProvider,
    Sender,
    Contract,
    ContractABI,
    ABIType,
    ABIGetter,
    ABIReceiver,
    TupleBuilder,
    DictionaryValue
} from '@ton/core';

export type DataSize = {
    $$type: 'DataSize';
    cells: bigint;
    bits: bigint;
    refs: bigint;
}

export function storeDataSize(src: DataSize) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeInt(src.cells, 257);
        b_0.storeInt(src.bits, 257);
        b_0.storeInt(src.refs, 257);
    };
}

export function loadDataSize(slice: Slice) {
    const sc_0 = slice;
    const _cells = sc_0.loadIntBig(257);
    const _bits = sc_0.loadIntBig(257);
    const _refs = sc_0.loadIntBig(257);
    return { $$type: 'DataSize' as const, cells: _cells, bits: _bits, refs: _refs };
}

export function loadTupleDataSize(source: TupleReader) {
    const _cells = source.readBigNumber();
    const _bits = source.readBigNumber();
    const _refs = source.readBigNumber();
    return { $$type: 'DataSize' as const, cells: _cells, bits: _bits, refs: _refs };
}

export function loadGetterTupleDataSize(source: TupleReader) {
    const _cells = source.readBigNumber();
    const _bits = source.readBigNumber();
    const _refs = source.readBigNumber();
    return { $$type: 'DataSize' as const, cells: _cells, bits: _bits, refs: _refs };
}

export function storeTupleDataSize(source: DataSize) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.cells);
    builder.writeNumber(source.bits);
    builder.writeNumber(source.refs);
    return builder.build();
}

export function dictValueParserDataSize(): DictionaryValue<DataSize> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeDataSize(src)).endCell());
        },
        parse: (src) => {
            return loadDataSize(src.loadRef().beginParse());
        }
    }
}

export type SignedBundle = {
    $$type: 'SignedBundle';
    signature: Buffer;
    signedData: Slice;
}

export function storeSignedBundle(src: SignedBundle) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeBuffer(src.signature);
        b_0.storeBuilder(src.signedData.asBuilder());
    };
}

export function loadSignedBundle(slice: Slice) {
    const sc_0 = slice;
    const _signature = sc_0.loadBuffer(64);
    const _signedData = sc_0;
    return { $$type: 'SignedBundle' as const, signature: _signature, signedData: _signedData };
}

export function loadTupleSignedBundle(source: TupleReader) {
    const _signature = source.readBuffer();
    const _signedData = source.readCell().asSlice();
    return { $$type: 'SignedBundle' as const, signature: _signature, signedData: _signedData };
}

export function loadGetterTupleSignedBundle(source: TupleReader) {
    const _signature = source.readBuffer();
    const _signedData = source.readCell().asSlice();
    return { $$type: 'SignedBundle' as const, signature: _signature, signedData: _signedData };
}

export function storeTupleSignedBundle(source: SignedBundle) {
    const builder = new TupleBuilder();
    builder.writeBuffer(source.signature);
    builder.writeSlice(source.signedData.asCell());
    return builder.build();
}

export function dictValueParserSignedBundle(): DictionaryValue<SignedBundle> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeSignedBundle(src)).endCell());
        },
        parse: (src) => {
            return loadSignedBundle(src.loadRef().beginParse());
        }
    }
}

export type StateInit = {
    $$type: 'StateInit';
    code: Cell;
    data: Cell;
}

export function storeStateInit(src: StateInit) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeRef(src.code);
        b_0.storeRef(src.data);
    };
}

export function loadStateInit(slice: Slice) {
    const sc_0 = slice;
    const _code = sc_0.loadRef();
    const _data = sc_0.loadRef();
    return { $$type: 'StateInit' as const, code: _code, data: _data };
}

export function loadTupleStateInit(source: TupleReader) {
    const _code = source.readCell();
    const _data = source.readCell();
    return { $$type: 'StateInit' as const, code: _code, data: _data };
}

export function loadGetterTupleStateInit(source: TupleReader) {
    const _code = source.readCell();
    const _data = source.readCell();
    return { $$type: 'StateInit' as const, code: _code, data: _data };
}

export function storeTupleStateInit(source: StateInit) {
    const builder = new TupleBuilder();
    builder.writeCell(source.code);
    builder.writeCell(source.data);
    return builder.build();
}

export function dictValueParserStateInit(): DictionaryValue<StateInit> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeStateInit(src)).endCell());
        },
        parse: (src) => {
            return loadStateInit(src.loadRef().beginParse());
        }
    }
}

export type Context = {
    $$type: 'Context';
    bounceable: boolean;
    sender: Address;
    value: bigint;
    raw: Slice;
}

export function storeContext(src: Context) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeBit(src.bounceable);
        b_0.storeAddress(src.sender);
        b_0.storeInt(src.value, 257);
        b_0.storeRef(src.raw.asCell());
    };
}

export function loadContext(slice: Slice) {
    const sc_0 = slice;
    const _bounceable = sc_0.loadBit();
    const _sender = sc_0.loadAddress();
    const _value = sc_0.loadIntBig(257);
    const _raw = sc_0.loadRef().asSlice();
    return { $$type: 'Context' as const, bounceable: _bounceable, sender: _sender, value: _value, raw: _raw };
}

export function loadTupleContext(source: TupleReader) {
    const _bounceable = source.readBoolean();
    const _sender = source.readAddress();
    const _value = source.readBigNumber();
    const _raw = source.readCell().asSlice();
    return { $$type: 'Context' as const, bounceable: _bounceable, sender: _sender, value: _value, raw: _raw };
}

export function loadGetterTupleContext(source: TupleReader) {
    const _bounceable = source.readBoolean();
    const _sender = source.readAddress();
    const _value = source.readBigNumber();
    const _raw = source.readCell().asSlice();
    return { $$type: 'Context' as const, bounceable: _bounceable, sender: _sender, value: _value, raw: _raw };
}

export function storeTupleContext(source: Context) {
    const builder = new TupleBuilder();
    builder.writeBoolean(source.bounceable);
    builder.writeAddress(source.sender);
    builder.writeNumber(source.value);
    builder.writeSlice(source.raw.asCell());
    return builder.build();
}

export function dictValueParserContext(): DictionaryValue<Context> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeContext(src)).endCell());
        },
        parse: (src) => {
            return loadContext(src.loadRef().beginParse());
        }
    }
}

export type SendParameters = {
    $$type: 'SendParameters';
    mode: bigint;
    body: Cell | null;
    code: Cell | null;
    data: Cell | null;
    value: bigint;
    to: Address;
    bounce: boolean;
}

export function storeSendParameters(src: SendParameters) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeInt(src.mode, 257);
        if (src.body !== null && src.body !== undefined) { b_0.storeBit(true).storeRef(src.body); } else { b_0.storeBit(false); }
        if (src.code !== null && src.code !== undefined) { b_0.storeBit(true).storeRef(src.code); } else { b_0.storeBit(false); }
        if (src.data !== null && src.data !== undefined) { b_0.storeBit(true).storeRef(src.data); } else { b_0.storeBit(false); }
        b_0.storeInt(src.value, 257);
        b_0.storeAddress(src.to);
        b_0.storeBit(src.bounce);
    };
}

export function loadSendParameters(slice: Slice) {
    const sc_0 = slice;
    const _mode = sc_0.loadIntBig(257);
    const _body = sc_0.loadBit() ? sc_0.loadRef() : null;
    const _code = sc_0.loadBit() ? sc_0.loadRef() : null;
    const _data = sc_0.loadBit() ? sc_0.loadRef() : null;
    const _value = sc_0.loadIntBig(257);
    const _to = sc_0.loadAddress();
    const _bounce = sc_0.loadBit();
    return { $$type: 'SendParameters' as const, mode: _mode, body: _body, code: _code, data: _data, value: _value, to: _to, bounce: _bounce };
}

export function loadTupleSendParameters(source: TupleReader) {
    const _mode = source.readBigNumber();
    const _body = source.readCellOpt();
    const _code = source.readCellOpt();
    const _data = source.readCellOpt();
    const _value = source.readBigNumber();
    const _to = source.readAddress();
    const _bounce = source.readBoolean();
    return { $$type: 'SendParameters' as const, mode: _mode, body: _body, code: _code, data: _data, value: _value, to: _to, bounce: _bounce };
}

export function loadGetterTupleSendParameters(source: TupleReader) {
    const _mode = source.readBigNumber();
    const _body = source.readCellOpt();
    const _code = source.readCellOpt();
    const _data = source.readCellOpt();
    const _value = source.readBigNumber();
    const _to = source.readAddress();
    const _bounce = source.readBoolean();
    return { $$type: 'SendParameters' as const, mode: _mode, body: _body, code: _code, data: _data, value: _value, to: _to, bounce: _bounce };
}

export function storeTupleSendParameters(source: SendParameters) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.mode);
    builder.writeCell(source.body);
    builder.writeCell(source.code);
    builder.writeCell(source.data);
    builder.writeNumber(source.value);
    builder.writeAddress(source.to);
    builder.writeBoolean(source.bounce);
    return builder.build();
}

export function dictValueParserSendParameters(): DictionaryValue<SendParameters> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeSendParameters(src)).endCell());
        },
        parse: (src) => {
            return loadSendParameters(src.loadRef().beginParse());
        }
    }
}

export type MessageParameters = {
    $$type: 'MessageParameters';
    mode: bigint;
    body: Cell | null;
    value: bigint;
    to: Address;
    bounce: boolean;
}

export function storeMessageParameters(src: MessageParameters) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeInt(src.mode, 257);
        if (src.body !== null && src.body !== undefined) { b_0.storeBit(true).storeRef(src.body); } else { b_0.storeBit(false); }
        b_0.storeInt(src.value, 257);
        b_0.storeAddress(src.to);
        b_0.storeBit(src.bounce);
    };
}

export function loadMessageParameters(slice: Slice) {
    const sc_0 = slice;
    const _mode = sc_0.loadIntBig(257);
    const _body = sc_0.loadBit() ? sc_0.loadRef() : null;
    const _value = sc_0.loadIntBig(257);
    const _to = sc_0.loadAddress();
    const _bounce = sc_0.loadBit();
    return { $$type: 'MessageParameters' as const, mode: _mode, body: _body, value: _value, to: _to, bounce: _bounce };
}

export function loadTupleMessageParameters(source: TupleReader) {
    const _mode = source.readBigNumber();
    const _body = source.readCellOpt();
    const _value = source.readBigNumber();
    const _to = source.readAddress();
    const _bounce = source.readBoolean();
    return { $$type: 'MessageParameters' as const, mode: _mode, body: _body, value: _value, to: _to, bounce: _bounce };
}

export function loadGetterTupleMessageParameters(source: TupleReader) {
    const _mode = source.readBigNumber();
    const _body = source.readCellOpt();
    const _value = source.readBigNumber();
    const _to = source.readAddress();
    const _bounce = source.readBoolean();
    return { $$type: 'MessageParameters' as const, mode: _mode, body: _body, value: _value, to: _to, bounce: _bounce };
}

export function storeTupleMessageParameters(source: MessageParameters) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.mode);
    builder.writeCell(source.body);
    builder.writeNumber(source.value);
    builder.writeAddress(source.to);
    builder.writeBoolean(source.bounce);
    return builder.build();
}

export function dictValueParserMessageParameters(): DictionaryValue<MessageParameters> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeMessageParameters(src)).endCell());
        },
        parse: (src) => {
            return loadMessageParameters(src.loadRef().beginParse());
        }
    }
}

export type DeployParameters = {
    $$type: 'DeployParameters';
    mode: bigint;
    body: Cell | null;
    value: bigint;
    bounce: boolean;
    init: StateInit;
}

export function storeDeployParameters(src: DeployParameters) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeInt(src.mode, 257);
        if (src.body !== null && src.body !== undefined) { b_0.storeBit(true).storeRef(src.body); } else { b_0.storeBit(false); }
        b_0.storeInt(src.value, 257);
        b_0.storeBit(src.bounce);
        b_0.store(storeStateInit(src.init));
    };
}

export function loadDeployParameters(slice: Slice) {
    const sc_0 = slice;
    const _mode = sc_0.loadIntBig(257);
    const _body = sc_0.loadBit() ? sc_0.loadRef() : null;
    const _value = sc_0.loadIntBig(257);
    const _bounce = sc_0.loadBit();
    const _init = loadStateInit(sc_0);
    return { $$type: 'DeployParameters' as const, mode: _mode, body: _body, value: _value, bounce: _bounce, init: _init };
}

export function loadTupleDeployParameters(source: TupleReader) {
    const _mode = source.readBigNumber();
    const _body = source.readCellOpt();
    const _value = source.readBigNumber();
    const _bounce = source.readBoolean();
    const _init = loadTupleStateInit(source);
    return { $$type: 'DeployParameters' as const, mode: _mode, body: _body, value: _value, bounce: _bounce, init: _init };
}

export function loadGetterTupleDeployParameters(source: TupleReader) {
    const _mode = source.readBigNumber();
    const _body = source.readCellOpt();
    const _value = source.readBigNumber();
    const _bounce = source.readBoolean();
    const _init = loadGetterTupleStateInit(source);
    return { $$type: 'DeployParameters' as const, mode: _mode, body: _body, value: _value, bounce: _bounce, init: _init };
}

export function storeTupleDeployParameters(source: DeployParameters) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.mode);
    builder.writeCell(source.body);
    builder.writeNumber(source.value);
    builder.writeBoolean(source.bounce);
    builder.writeTuple(storeTupleStateInit(source.init));
    return builder.build();
}

export function dictValueParserDeployParameters(): DictionaryValue<DeployParameters> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeDeployParameters(src)).endCell());
        },
        parse: (src) => {
            return loadDeployParameters(src.loadRef().beginParse());
        }
    }
}

export type StdAddress = {
    $$type: 'StdAddress';
    workchain: bigint;
    address: bigint;
}

export function storeStdAddress(src: StdAddress) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeInt(src.workchain, 8);
        b_0.storeUint(src.address, 256);
    };
}

export function loadStdAddress(slice: Slice) {
    const sc_0 = slice;
    const _workchain = sc_0.loadIntBig(8);
    const _address = sc_0.loadUintBig(256);
    return { $$type: 'StdAddress' as const, workchain: _workchain, address: _address };
}

export function loadTupleStdAddress(source: TupleReader) {
    const _workchain = source.readBigNumber();
    const _address = source.readBigNumber();
    return { $$type: 'StdAddress' as const, workchain: _workchain, address: _address };
}

export function loadGetterTupleStdAddress(source: TupleReader) {
    const _workchain = source.readBigNumber();
    const _address = source.readBigNumber();
    return { $$type: 'StdAddress' as const, workchain: _workchain, address: _address };
}

export function storeTupleStdAddress(source: StdAddress) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.workchain);
    builder.writeNumber(source.address);
    return builder.build();
}

export function dictValueParserStdAddress(): DictionaryValue<StdAddress> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeStdAddress(src)).endCell());
        },
        parse: (src) => {
            return loadStdAddress(src.loadRef().beginParse());
        }
    }
}

export type VarAddress = {
    $$type: 'VarAddress';
    workchain: bigint;
    address: Slice;
}

export function storeVarAddress(src: VarAddress) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeInt(src.workchain, 32);
        b_0.storeRef(src.address.asCell());
    };
}

export function loadVarAddress(slice: Slice) {
    const sc_0 = slice;
    const _workchain = sc_0.loadIntBig(32);
    const _address = sc_0.loadRef().asSlice();
    return { $$type: 'VarAddress' as const, workchain: _workchain, address: _address };
}

export function loadTupleVarAddress(source: TupleReader) {
    const _workchain = source.readBigNumber();
    const _address = source.readCell().asSlice();
    return { $$type: 'VarAddress' as const, workchain: _workchain, address: _address };
}

export function loadGetterTupleVarAddress(source: TupleReader) {
    const _workchain = source.readBigNumber();
    const _address = source.readCell().asSlice();
    return { $$type: 'VarAddress' as const, workchain: _workchain, address: _address };
}

export function storeTupleVarAddress(source: VarAddress) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.workchain);
    builder.writeSlice(source.address.asCell());
    return builder.build();
}

export function dictValueParserVarAddress(): DictionaryValue<VarAddress> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeVarAddress(src)).endCell());
        },
        parse: (src) => {
            return loadVarAddress(src.loadRef().beginParse());
        }
    }
}

export type BasechainAddress = {
    $$type: 'BasechainAddress';
    hash: bigint | null;
}

export function storeBasechainAddress(src: BasechainAddress) {
    return (builder: Builder) => {
        const b_0 = builder;
        if (src.hash !== null && src.hash !== undefined) { b_0.storeBit(true).storeInt(src.hash, 257); } else { b_0.storeBit(false); }
    };
}

export function loadBasechainAddress(slice: Slice) {
    const sc_0 = slice;
    const _hash = sc_0.loadBit() ? sc_0.loadIntBig(257) : null;
    return { $$type: 'BasechainAddress' as const, hash: _hash };
}

export function loadTupleBasechainAddress(source: TupleReader) {
    const _hash = source.readBigNumberOpt();
    return { $$type: 'BasechainAddress' as const, hash: _hash };
}

export function loadGetterTupleBasechainAddress(source: TupleReader) {
    const _hash = source.readBigNumberOpt();
    return { $$type: 'BasechainAddress' as const, hash: _hash };
}

export function storeTupleBasechainAddress(source: BasechainAddress) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.hash);
    return builder.build();
}

export function dictValueParserBasechainAddress(): DictionaryValue<BasechainAddress> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeBasechainAddress(src)).endCell());
        },
        parse: (src) => {
            return loadBasechainAddress(src.loadRef().beginParse());
        }
    }
}

export type ChangeOwner = {
    $$type: 'ChangeOwner';
    queryId: bigint;
    newOwner: Address;
}

export function storeChangeOwner(src: ChangeOwner) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeUint(2174598809, 32);
        b_0.storeUint(src.queryId, 64);
        b_0.storeAddress(src.newOwner);
    };
}

export function loadChangeOwner(slice: Slice) {
    const sc_0 = slice;
    if (sc_0.loadUint(32) !== 2174598809) { throw Error('Invalid prefix'); }
    const _queryId = sc_0.loadUintBig(64);
    const _newOwner = sc_0.loadAddress();
    return { $$type: 'ChangeOwner' as const, queryId: _queryId, newOwner: _newOwner };
}

export function loadTupleChangeOwner(source: TupleReader) {
    const _queryId = source.readBigNumber();
    const _newOwner = source.readAddress();
    return { $$type: 'ChangeOwner' as const, queryId: _queryId, newOwner: _newOwner };
}

export function loadGetterTupleChangeOwner(source: TupleReader) {
    const _queryId = source.readBigNumber();
    const _newOwner = source.readAddress();
    return { $$type: 'ChangeOwner' as const, queryId: _queryId, newOwner: _newOwner };
}

export function storeTupleChangeOwner(source: ChangeOwner) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.queryId);
    builder.writeAddress(source.newOwner);
    return builder.build();
}

export function dictValueParserChangeOwner(): DictionaryValue<ChangeOwner> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeChangeOwner(src)).endCell());
        },
        parse: (src) => {
            return loadChangeOwner(src.loadRef().beginParse());
        }
    }
}

export type ChangeOwnerOk = {
    $$type: 'ChangeOwnerOk';
    queryId: bigint;
    newOwner: Address;
}

export function storeChangeOwnerOk(src: ChangeOwnerOk) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeUint(846932810, 32);
        b_0.storeUint(src.queryId, 64);
        b_0.storeAddress(src.newOwner);
    };
}

export function loadChangeOwnerOk(slice: Slice) {
    const sc_0 = slice;
    if (sc_0.loadUint(32) !== 846932810) { throw Error('Invalid prefix'); }
    const _queryId = sc_0.loadUintBig(64);
    const _newOwner = sc_0.loadAddress();
    return { $$type: 'ChangeOwnerOk' as const, queryId: _queryId, newOwner: _newOwner };
}

export function loadTupleChangeOwnerOk(source: TupleReader) {
    const _queryId = source.readBigNumber();
    const _newOwner = source.readAddress();
    return { $$type: 'ChangeOwnerOk' as const, queryId: _queryId, newOwner: _newOwner };
}

export function loadGetterTupleChangeOwnerOk(source: TupleReader) {
    const _queryId = source.readBigNumber();
    const _newOwner = source.readAddress();
    return { $$type: 'ChangeOwnerOk' as const, queryId: _queryId, newOwner: _newOwner };
}

export function storeTupleChangeOwnerOk(source: ChangeOwnerOk) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.queryId);
    builder.writeAddress(source.newOwner);
    return builder.build();
}

export function dictValueParserChangeOwnerOk(): DictionaryValue<ChangeOwnerOk> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeChangeOwnerOk(src)).endCell());
        },
        parse: (src) => {
            return loadChangeOwnerOk(src.loadRef().beginParse());
        }
    }
}

export type Fund = {
    $$type: 'Fund';
    dealId: bigint;
}

export function storeFund(src: Fund) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeUint(1, 32);
        b_0.storeUint(src.dealId, 64);
    };
}

export function loadFund(slice: Slice) {
    const sc_0 = slice;
    if (sc_0.loadUint(32) !== 1) { throw Error('Invalid prefix'); }
    const _dealId = sc_0.loadUintBig(64);
    return { $$type: 'Fund' as const, dealId: _dealId };
}

export function loadTupleFund(source: TupleReader) {
    const _dealId = source.readBigNumber();
    return { $$type: 'Fund' as const, dealId: _dealId };
}

export function loadGetterTupleFund(source: TupleReader) {
    const _dealId = source.readBigNumber();
    return { $$type: 'Fund' as const, dealId: _dealId };
}

export function storeTupleFund(source: Fund) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.dealId);
    return builder.build();
}

export function dictValueParserFund(): DictionaryValue<Fund> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeFund(src)).endCell());
        },
        parse: (src) => {
            return loadFund(src.loadRef().beginParse());
        }
    }
}

export type Release = {
    $$type: 'Release';
    dealId: bigint;
}

export function storeRelease(src: Release) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeUint(2, 32);
        b_0.storeUint(src.dealId, 64);
    };
}

export function loadRelease(slice: Slice) {
    const sc_0 = slice;
    if (sc_0.loadUint(32) !== 2) { throw Error('Invalid prefix'); }
    const _dealId = sc_0.loadUintBig(64);
    return { $$type: 'Release' as const, dealId: _dealId };
}

export function loadTupleRelease(source: TupleReader) {
    const _dealId = source.readBigNumber();
    return { $$type: 'Release' as const, dealId: _dealId };
}

export function loadGetterTupleRelease(source: TupleReader) {
    const _dealId = source.readBigNumber();
    return { $$type: 'Release' as const, dealId: _dealId };
}

export function storeTupleRelease(source: Release) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.dealId);
    return builder.build();
}

export function dictValueParserRelease(): DictionaryValue<Release> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeRelease(src)).endCell());
        },
        parse: (src) => {
            return loadRelease(src.loadRef().beginParse());
        }
    }
}

export type Refund = {
    $$type: 'Refund';
    dealId: bigint;
}

export function storeRefund(src: Refund) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeUint(3, 32);
        b_0.storeUint(src.dealId, 64);
    };
}

export function loadRefund(slice: Slice) {
    const sc_0 = slice;
    if (sc_0.loadUint(32) !== 3) { throw Error('Invalid prefix'); }
    const _dealId = sc_0.loadUintBig(64);
    return { $$type: 'Refund' as const, dealId: _dealId };
}

export function loadTupleRefund(source: TupleReader) {
    const _dealId = source.readBigNumber();
    return { $$type: 'Refund' as const, dealId: _dealId };
}

export function loadGetterTupleRefund(source: TupleReader) {
    const _dealId = source.readBigNumber();
    return { $$type: 'Refund' as const, dealId: _dealId };
}

export function storeTupleRefund(source: Refund) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.dealId);
    return builder.build();
}

export function dictValueParserRefund(): DictionaryValue<Refund> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeRefund(src)).endCell());
        },
        parse: (src) => {
            return loadRefund(src.loadRef().beginParse());
        }
    }
}

export type Dispute = {
    $$type: 'Dispute';
    dealId: bigint;
    reason: string;
}

export function storeDispute(src: Dispute) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeUint(4, 32);
        b_0.storeUint(src.dealId, 64);
        b_0.storeStringRefTail(src.reason);
    };
}

export function loadDispute(slice: Slice) {
    const sc_0 = slice;
    if (sc_0.loadUint(32) !== 4) { throw Error('Invalid prefix'); }
    const _dealId = sc_0.loadUintBig(64);
    const _reason = sc_0.loadStringRefTail();
    return { $$type: 'Dispute' as const, dealId: _dealId, reason: _reason };
}

export function loadTupleDispute(source: TupleReader) {
    const _dealId = source.readBigNumber();
    const _reason = source.readString();
    return { $$type: 'Dispute' as const, dealId: _dealId, reason: _reason };
}

export function loadGetterTupleDispute(source: TupleReader) {
    const _dealId = source.readBigNumber();
    const _reason = source.readString();
    return { $$type: 'Dispute' as const, dealId: _dealId, reason: _reason };
}

export function storeTupleDispute(source: Dispute) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.dealId);
    builder.writeString(source.reason);
    return builder.build();
}

export function dictValueParserDispute(): DictionaryValue<Dispute> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeDispute(src)).endCell());
        },
        parse: (src) => {
            return loadDispute(src.loadRef().beginParse());
        }
    }
}

export type ResolveDispute = {
    $$type: 'ResolveDispute';
    dealId: bigint;
    publisherShare: bigint;
    advertiserShare: bigint;
}

export function storeResolveDispute(src: ResolveDispute) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeUint(5, 32);
        b_0.storeUint(src.dealId, 64);
        b_0.storeUint(src.publisherShare, 32);
        b_0.storeUint(src.advertiserShare, 32);
    };
}

export function loadResolveDispute(slice: Slice) {
    const sc_0 = slice;
    if (sc_0.loadUint(32) !== 5) { throw Error('Invalid prefix'); }
    const _dealId = sc_0.loadUintBig(64);
    const _publisherShare = sc_0.loadUintBig(32);
    const _advertiserShare = sc_0.loadUintBig(32);
    return { $$type: 'ResolveDispute' as const, dealId: _dealId, publisherShare: _publisherShare, advertiserShare: _advertiserShare };
}

export function loadTupleResolveDispute(source: TupleReader) {
    const _dealId = source.readBigNumber();
    const _publisherShare = source.readBigNumber();
    const _advertiserShare = source.readBigNumber();
    return { $$type: 'ResolveDispute' as const, dealId: _dealId, publisherShare: _publisherShare, advertiserShare: _advertiserShare };
}

export function loadGetterTupleResolveDispute(source: TupleReader) {
    const _dealId = source.readBigNumber();
    const _publisherShare = source.readBigNumber();
    const _advertiserShare = source.readBigNumber();
    return { $$type: 'ResolveDispute' as const, dealId: _dealId, publisherShare: _publisherShare, advertiserShare: _advertiserShare };
}

export function storeTupleResolveDispute(source: ResolveDispute) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.dealId);
    builder.writeNumber(source.publisherShare);
    builder.writeNumber(source.advertiserShare);
    return builder.build();
}

export function dictValueParserResolveDispute(): DictionaryValue<ResolveDispute> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeResolveDispute(src)).endCell());
        },
        parse: (src) => {
            return loadResolveDispute(src.loadRef().beginParse());
        }
    }
}

export type UpdatePlatformFee = {
    $$type: 'UpdatePlatformFee';
    newFeeBps: bigint;
}

export function storeUpdatePlatformFee(src: UpdatePlatformFee) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeUint(6, 32);
        b_0.storeUint(src.newFeeBps, 16);
    };
}

export function loadUpdatePlatformFee(slice: Slice) {
    const sc_0 = slice;
    if (sc_0.loadUint(32) !== 6) { throw Error('Invalid prefix'); }
    const _newFeeBps = sc_0.loadUintBig(16);
    return { $$type: 'UpdatePlatformFee' as const, newFeeBps: _newFeeBps };
}

export function loadTupleUpdatePlatformFee(source: TupleReader) {
    const _newFeeBps = source.readBigNumber();
    return { $$type: 'UpdatePlatformFee' as const, newFeeBps: _newFeeBps };
}

export function loadGetterTupleUpdatePlatformFee(source: TupleReader) {
    const _newFeeBps = source.readBigNumber();
    return { $$type: 'UpdatePlatformFee' as const, newFeeBps: _newFeeBps };
}

export function storeTupleUpdatePlatformFee(source: UpdatePlatformFee) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.newFeeBps);
    return builder.build();
}

export function dictValueParserUpdatePlatformFee(): DictionaryValue<UpdatePlatformFee> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeUpdatePlatformFee(src)).endCell());
        },
        parse: (src) => {
            return loadUpdatePlatformFee(src.loadRef().beginParse());
        }
    }
}

export type UpdateBackendWallet = {
    $$type: 'UpdateBackendWallet';
    newBackendWallet: Address;
}

export function storeUpdateBackendWallet(src: UpdateBackendWallet) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeUint(7, 32);
        b_0.storeAddress(src.newBackendWallet);
    };
}

export function loadUpdateBackendWallet(slice: Slice) {
    const sc_0 = slice;
    if (sc_0.loadUint(32) !== 7) { throw Error('Invalid prefix'); }
    const _newBackendWallet = sc_0.loadAddress();
    return { $$type: 'UpdateBackendWallet' as const, newBackendWallet: _newBackendWallet };
}

export function loadTupleUpdateBackendWallet(source: TupleReader) {
    const _newBackendWallet = source.readAddress();
    return { $$type: 'UpdateBackendWallet' as const, newBackendWallet: _newBackendWallet };
}

export function loadGetterTupleUpdateBackendWallet(source: TupleReader) {
    const _newBackendWallet = source.readAddress();
    return { $$type: 'UpdateBackendWallet' as const, newBackendWallet: _newBackendWallet };
}

export function storeTupleUpdateBackendWallet(source: UpdateBackendWallet) {
    const builder = new TupleBuilder();
    builder.writeAddress(source.newBackendWallet);
    return builder.build();
}

export function dictValueParserUpdateBackendWallet(): DictionaryValue<UpdateBackendWallet> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeUpdateBackendWallet(src)).endCell());
        },
        parse: (src) => {
            return loadUpdateBackendWallet(src.loadRef().beginParse());
        }
    }
}

export type CreateEscrow = {
    $$type: 'CreateEscrow';
}

export function storeCreateEscrow(src: CreateEscrow) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeUint(8, 32);
    };
}

export function loadCreateEscrow(slice: Slice) {
    const sc_0 = slice;
    if (sc_0.loadUint(32) !== 8) { throw Error('Invalid prefix'); }
    return { $$type: 'CreateEscrow' as const };
}

export function loadTupleCreateEscrow(source: TupleReader) {
    return { $$type: 'CreateEscrow' as const };
}

export function loadGetterTupleCreateEscrow(source: TupleReader) {
    return { $$type: 'CreateEscrow' as const };
}

export function storeTupleCreateEscrow(source: CreateEscrow) {
    const builder = new TupleBuilder();
    return builder.build();
}

export function dictValueParserCreateEscrow(): DictionaryValue<CreateEscrow> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeCreateEscrow(src)).endCell());
        },
        parse: (src) => {
            return loadCreateEscrow(src.loadRef().beginParse());
        }
    }
}

export type DeployEscrow = {
    $$type: 'DeployEscrow';
    queryId: bigint;
}

export function storeDeployEscrow(src: DeployEscrow) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeUint(9, 32);
        b_0.storeUint(src.queryId, 64);
    };
}

export function loadDeployEscrow(slice: Slice) {
    const sc_0 = slice;
    if (sc_0.loadUint(32) !== 9) { throw Error('Invalid prefix'); }
    const _queryId = sc_0.loadUintBig(64);
    return { $$type: 'DeployEscrow' as const, queryId: _queryId };
}

export function loadTupleDeployEscrow(source: TupleReader) {
    const _queryId = source.readBigNumber();
    return { $$type: 'DeployEscrow' as const, queryId: _queryId };
}

export function loadGetterTupleDeployEscrow(source: TupleReader) {
    const _queryId = source.readBigNumber();
    return { $$type: 'DeployEscrow' as const, queryId: _queryId };
}

export function storeTupleDeployEscrow(source: DeployEscrow) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.queryId);
    return builder.build();
}

export function dictValueParserDeployEscrow(): DictionaryValue<DeployEscrow> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeDeployEscrow(src)).endCell());
        },
        parse: (src) => {
            return loadDeployEscrow(src.loadRef().beginParse());
        }
    }
}

export type DealInfo = {
    $$type: 'DealInfo';
    advertiser: Address;
    publisher: Address;
    amount: bigint;
    platformFee: bigint;
    publisherAmount: bigint;
    fundedAt: bigint;
    status: bigint;
}

export function storeDealInfo(src: DealInfo) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeAddress(src.advertiser);
        b_0.storeAddress(src.publisher);
        b_0.storeCoins(src.amount);
        b_0.storeCoins(src.platformFee);
        b_0.storeCoins(src.publisherAmount);
        b_0.storeUint(src.fundedAt, 64);
        b_0.storeUint(src.status, 8);
    };
}

export function loadDealInfo(slice: Slice) {
    const sc_0 = slice;
    const _advertiser = sc_0.loadAddress();
    const _publisher = sc_0.loadAddress();
    const _amount = sc_0.loadCoins();
    const _platformFee = sc_0.loadCoins();
    const _publisherAmount = sc_0.loadCoins();
    const _fundedAt = sc_0.loadUintBig(64);
    const _status = sc_0.loadUintBig(8);
    return { $$type: 'DealInfo' as const, advertiser: _advertiser, publisher: _publisher, amount: _amount, platformFee: _platformFee, publisherAmount: _publisherAmount, fundedAt: _fundedAt, status: _status };
}

export function loadTupleDealInfo(source: TupleReader) {
    const _advertiser = source.readAddress();
    const _publisher = source.readAddress();
    const _amount = source.readBigNumber();
    const _platformFee = source.readBigNumber();
    const _publisherAmount = source.readBigNumber();
    const _fundedAt = source.readBigNumber();
    const _status = source.readBigNumber();
    return { $$type: 'DealInfo' as const, advertiser: _advertiser, publisher: _publisher, amount: _amount, platformFee: _platformFee, publisherAmount: _publisherAmount, fundedAt: _fundedAt, status: _status };
}

export function loadGetterTupleDealInfo(source: TupleReader) {
    const _advertiser = source.readAddress();
    const _publisher = source.readAddress();
    const _amount = source.readBigNumber();
    const _platformFee = source.readBigNumber();
    const _publisherAmount = source.readBigNumber();
    const _fundedAt = source.readBigNumber();
    const _status = source.readBigNumber();
    return { $$type: 'DealInfo' as const, advertiser: _advertiser, publisher: _publisher, amount: _amount, platformFee: _platformFee, publisherAmount: _publisherAmount, fundedAt: _fundedAt, status: _status };
}

export function storeTupleDealInfo(source: DealInfo) {
    const builder = new TupleBuilder();
    builder.writeAddress(source.advertiser);
    builder.writeAddress(source.publisher);
    builder.writeNumber(source.amount);
    builder.writeNumber(source.platformFee);
    builder.writeNumber(source.publisherAmount);
    builder.writeNumber(source.fundedAt);
    builder.writeNumber(source.status);
    return builder.build();
}

export function dictValueParserDealInfo(): DictionaryValue<DealInfo> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeDealInfo(src)).endCell());
        },
        parse: (src) => {
            return loadDealInfo(src.loadRef().beginParse());
        }
    }
}

export type EscrowFactory$Data = {
    $$type: 'EscrowFactory$Data';
    owner: Address;
    platformWallet: Address;
    backendWallet: Address;
    platformFeeBps: bigint;
    minFee: bigint;
    totalDeals: bigint;
}

export function storeEscrowFactory$Data(src: EscrowFactory$Data) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeAddress(src.owner);
        b_0.storeAddress(src.platformWallet);
        b_0.storeAddress(src.backendWallet);
        b_0.storeUint(src.platformFeeBps, 16);
        b_0.storeCoins(src.minFee);
        b_0.storeUint(src.totalDeals, 64);
    };
}

export function loadEscrowFactory$Data(slice: Slice) {
    const sc_0 = slice;
    const _owner = sc_0.loadAddress();
    const _platformWallet = sc_0.loadAddress();
    const _backendWallet = sc_0.loadAddress();
    const _platformFeeBps = sc_0.loadUintBig(16);
    const _minFee = sc_0.loadCoins();
    const _totalDeals = sc_0.loadUintBig(64);
    return { $$type: 'EscrowFactory$Data' as const, owner: _owner, platformWallet: _platformWallet, backendWallet: _backendWallet, platformFeeBps: _platformFeeBps, minFee: _minFee, totalDeals: _totalDeals };
}

export function loadTupleEscrowFactory$Data(source: TupleReader) {
    const _owner = source.readAddress();
    const _platformWallet = source.readAddress();
    const _backendWallet = source.readAddress();
    const _platformFeeBps = source.readBigNumber();
    const _minFee = source.readBigNumber();
    const _totalDeals = source.readBigNumber();
    return { $$type: 'EscrowFactory$Data' as const, owner: _owner, platformWallet: _platformWallet, backendWallet: _backendWallet, platformFeeBps: _platformFeeBps, minFee: _minFee, totalDeals: _totalDeals };
}

export function loadGetterTupleEscrowFactory$Data(source: TupleReader) {
    const _owner = source.readAddress();
    const _platformWallet = source.readAddress();
    const _backendWallet = source.readAddress();
    const _platformFeeBps = source.readBigNumber();
    const _minFee = source.readBigNumber();
    const _totalDeals = source.readBigNumber();
    return { $$type: 'EscrowFactory$Data' as const, owner: _owner, platformWallet: _platformWallet, backendWallet: _backendWallet, platformFeeBps: _platformFeeBps, minFee: _minFee, totalDeals: _totalDeals };
}

export function storeTupleEscrowFactory$Data(source: EscrowFactory$Data) {
    const builder = new TupleBuilder();
    builder.writeAddress(source.owner);
    builder.writeAddress(source.platformWallet);
    builder.writeAddress(source.backendWallet);
    builder.writeNumber(source.platformFeeBps);
    builder.writeNumber(source.minFee);
    builder.writeNumber(source.totalDeals);
    return builder.build();
}

export function dictValueParserEscrowFactory$Data(): DictionaryValue<EscrowFactory$Data> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeEscrowFactory$Data(src)).endCell());
        },
        parse: (src) => {
            return loadEscrowFactory$Data(src.loadRef().beginParse());
        }
    }
}

export type DealEscrow$Data = {
    $$type: 'DealEscrow$Data';
    dealId: bigint;
    advertiser: Address;
    publisher: Address;
    arbiter: Address;
    feeReceiver: Address;
    amount: bigint;
    platformFeeBps: bigint;
    fundedAt: bigint;
    disputedAt: bigint;
    disputeCount: bigint;
    refundDeadline: bigint;
    status: bigint;
}

export function storeDealEscrow$Data(src: DealEscrow$Data) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeUint(src.dealId, 64);
        b_0.storeAddress(src.advertiser);
        b_0.storeAddress(src.publisher);
        b_0.storeAddress(src.arbiter);
        const b_1 = new Builder();
        b_1.storeAddress(src.feeReceiver);
        b_1.storeCoins(src.amount);
        b_1.storeUint(src.platformFeeBps, 16);
        b_1.storeUint(src.fundedAt, 64);
        b_1.storeUint(src.disputedAt, 64);
        b_1.storeUint(src.disputeCount, 8);
        b_1.storeUint(src.refundDeadline, 64);
        b_1.storeUint(src.status, 8);
        b_0.storeRef(b_1.endCell());
    };
}

export function loadDealEscrow$Data(slice: Slice) {
    const sc_0 = slice;
    const _dealId = sc_0.loadUintBig(64);
    const _advertiser = sc_0.loadAddress();
    const _publisher = sc_0.loadAddress();
    const _arbiter = sc_0.loadAddress();
    const sc_1 = sc_0.loadRef().beginParse();
    const _feeReceiver = sc_1.loadAddress();
    const _amount = sc_1.loadCoins();
    const _platformFeeBps = sc_1.loadUintBig(16);
    const _fundedAt = sc_1.loadUintBig(64);
    const _disputedAt = sc_1.loadUintBig(64);
    const _disputeCount = sc_1.loadUintBig(8);
    const _refundDeadline = sc_1.loadUintBig(64);
    const _status = sc_1.loadUintBig(8);
    return { $$type: 'DealEscrow$Data' as const, dealId: _dealId, advertiser: _advertiser, publisher: _publisher, arbiter: _arbiter, feeReceiver: _feeReceiver, amount: _amount, platformFeeBps: _platformFeeBps, fundedAt: _fundedAt, disputedAt: _disputedAt, disputeCount: _disputeCount, refundDeadline: _refundDeadline, status: _status };
}

export function loadTupleDealEscrow$Data(source: TupleReader) {
    const _dealId = source.readBigNumber();
    const _advertiser = source.readAddress();
    const _publisher = source.readAddress();
    const _arbiter = source.readAddress();
    const _feeReceiver = source.readAddress();
    const _amount = source.readBigNumber();
    const _platformFeeBps = source.readBigNumber();
    const _fundedAt = source.readBigNumber();
    const _disputedAt = source.readBigNumber();
    const _disputeCount = source.readBigNumber();
    const _refundDeadline = source.readBigNumber();
    const _status = source.readBigNumber();
    return { $$type: 'DealEscrow$Data' as const, dealId: _dealId, advertiser: _advertiser, publisher: _publisher, arbiter: _arbiter, feeReceiver: _feeReceiver, amount: _amount, platformFeeBps: _platformFeeBps, fundedAt: _fundedAt, disputedAt: _disputedAt, disputeCount: _disputeCount, refundDeadline: _refundDeadline, status: _status };
}

export function loadGetterTupleDealEscrow$Data(source: TupleReader) {
    const _dealId = source.readBigNumber();
    const _advertiser = source.readAddress();
    const _publisher = source.readAddress();
    const _arbiter = source.readAddress();
    const _feeReceiver = source.readAddress();
    const _amount = source.readBigNumber();
    const _platformFeeBps = source.readBigNumber();
    const _fundedAt = source.readBigNumber();
    const _disputedAt = source.readBigNumber();
    const _disputeCount = source.readBigNumber();
    const _refundDeadline = source.readBigNumber();
    const _status = source.readBigNumber();
    return { $$type: 'DealEscrow$Data' as const, dealId: _dealId, advertiser: _advertiser, publisher: _publisher, arbiter: _arbiter, feeReceiver: _feeReceiver, amount: _amount, platformFeeBps: _platformFeeBps, fundedAt: _fundedAt, disputedAt: _disputedAt, disputeCount: _disputeCount, refundDeadline: _refundDeadline, status: _status };
}

export function storeTupleDealEscrow$Data(source: DealEscrow$Data) {
    const builder = new TupleBuilder();
    builder.writeNumber(source.dealId);
    builder.writeAddress(source.advertiser);
    builder.writeAddress(source.publisher);
    builder.writeAddress(source.arbiter);
    builder.writeAddress(source.feeReceiver);
    builder.writeNumber(source.amount);
    builder.writeNumber(source.platformFeeBps);
    builder.writeNumber(source.fundedAt);
    builder.writeNumber(source.disputedAt);
    builder.writeNumber(source.disputeCount);
    builder.writeNumber(source.refundDeadline);
    builder.writeNumber(source.status);
    return builder.build();
}

export function dictValueParserDealEscrow$Data(): DictionaryValue<DealEscrow$Data> {
    return {
        serialize: (src, builder) => {
            builder.storeRef(beginCell().store(storeDealEscrow$Data(src)).endCell());
        },
        parse: (src) => {
            return loadDealEscrow$Data(src.loadRef().beginParse());
        }
    }
}

 type DealEscrow_init_args = {
    $$type: 'DealEscrow_init_args';
    dealId: bigint;
    advertiser: Address;
    publisher: Address;
    arbiter: Address;
    feeReceiver: Address;
    platformFeeBps: bigint;
    expectedAmount: bigint;
    refundDeadline: bigint;
}

function initDealEscrow_init_args(src: DealEscrow_init_args) {
    return (builder: Builder) => {
        const b_0 = builder;
        b_0.storeInt(src.dealId, 257);
        b_0.storeAddress(src.advertiser);
        b_0.storeAddress(src.publisher);
        const b_1 = new Builder();
        b_1.storeAddress(src.arbiter);
        b_1.storeAddress(src.feeReceiver);
        b_1.storeInt(src.platformFeeBps, 257);
        const b_2 = new Builder();
        b_2.storeInt(src.expectedAmount, 257);
        b_2.storeInt(src.refundDeadline, 257);
        b_1.storeRef(b_2.endCell());
        b_0.storeRef(b_1.endCell());
    };
}

async function DealEscrow_init(dealId: bigint, advertiser: Address, publisher: Address, arbiter: Address, feeReceiver: Address, platformFeeBps: bigint, expectedAmount: bigint, refundDeadline: bigint) {
    const __code = Cell.fromHex('b5ee9c7241021c0100088d000228ff008e88f4a413f4bcf2c80bed5320e303ed43d9010b020271020301c3beb6f76a268690000c729408080eb807d207d206a00e87d207d20408080eb806a1868408080eb80408080eb8018082c082b882b0468aa83298940b65e82c083e85d8af97a40a15301c10802faf0805f09f97a382a3800082b081a2098718693b660c0c0201200409020148050601c3b342bb51343480006394a0404075c03e903e903500743e903e9020404075c0350c3420404075c020404075c00c04160415c4158234554194c4a05b2f416041f42ec57cbd2050a980e084017d78402f84fcbd1c151c000415840d104c38c3481b30600c020120070801c9af6076a268690000c729408080eb807d207d206a00e87d207d20408080eb806a1868408080eb80408080eb8018082c082b882b0468aa83298940b65e82c083e85d8af97a40a15301c10802faf0805f09f97a382a3800082b081a20987186fc13b7883660c00c01c3ae4ff6a268690000c729408080eb807d207d206a00e87d207d20408080eb806a1868408080eb80408080eb8018082c082b882b0468aa83298940b65e82c083e85d8af97a40a15301c10802faf0805f09f97a382a3800082b081a20987186943660c00c02bdba163ed44d0d200018e52810101d700fa40fa40d401d0fa40fa40810101d700d430d0810101d700810101d7003010581057105608d155065312816cbd058107d0bb15f2f48142a603821005f5e100be13f2f470547000105610344130e30d80c0a00b0547a962910bf10ae109d108c107f2e07106e105d041110044e1350df81271027a1a8812710a9041da151c681271027a1a8812710a90404111004103f4ed0535d0e11120e0d11110d0c11100c10bf10ae109d108c107b6cc703f83001d072d721d200d200fa4021103450666f04f86102f862ed44d0d200018e52810101d700fa40fa40d401d0fa40fa40810101d700d430d0810101d700810101d7003010581057105608d155065312816cbd058107d0bb15f2f48142a603821005f5e100be13f2f470547000105610344130e30d0de302702cd749200c0d10004cd33ffa40fa40fa40d401d0fa40fa00d30fd33fd33fd307d33fd30730108c108b108a10896c1c02b80b8020d7217021d749c21f9430d31f309131e220c0028e38302bc00292713cde109b5518c87f01ca0055b050bccb3f19ce17ce15ce03c8ce58fa02cb0f12cb3f12cb3f12cb0712cb3f12cb07cdc9ed54e020c003e302c005e3025f0c0e0f0070302bc00392713cde109b5518c87f01ca0055b050bccb3f19ce17ce15ce03c8ce58fa02cb0f12cb3f12cb3f12cb0712cb3f12cb07cdc9ed54006e2bc00292743cde109b5518c87f01ca0055b050bccb3f19ce17ce15ce03c8ce58fa02cb0f12cb3f12cb3f12cb0712cb3f12cb07cdc9ed5404a6c21f95310cd31f0dde21c0098e325b3b109b5518c87f01ca0055b050bccb3f19ce17ce15ce03c8ce58fa02cb0f12cb3f12cb3f12cb0712cb3f12cb07cdc9ed54e021c001e30221c002e30221c003e30221c0041113151701ec5b0bd33f308200e8dcf8422bc705f2f4816b002dc000f2f48200a4e3511bbaf2f4f8416f24135f0310ac109b108a107910681057104610354430123134820093de5346bef2f45135a120c2008e217370c8c92c5530441359c8cf8580ca00cf8440ce01fa02806acf40f400c901fb009130e2f8230371120058c87f01ca0055b050bccb3f19ce17ce15ce03c8ce58fa02cb0f12cb3f12cb3f12cb0712cb3f12cb07cdc9ed5401fe5b0bd33f308200a5c3f84229c705f2f48200c6482dc001f2f48200a4e3511bbaf2f4109b24109b108a1079106807551481271027a1a8812710a904318200d557f8276f1022820afaf080a0bef2f4727170c8c92d04055520441359c8cf8580ca00cf8440ce01fa02806acf40f400c901fb007081008270c8c92b5530441359140086c8cf8580ca00cf8440ce01fa02806acf40f400c901fb00c87f01ca0055b050bccb3f19ce17ce15ce03c8ce58fa02cb0f12cb3f12cb3f12cb0712cb3f12cb07cdc9ed5401fc5b0bd33f308200a4e3511bbaf2f48200c6480cc0011cf2f481283cf84227c705f2f48200d557f8276f1025820afaf080a0bef2f4737170c8c92b51384133441359c8cf8580ca00cf8440ce01fa02806acf40f400c901fb007081008270c8c9295530441359c8cf8580ca00cf8440ce01fa02806acf40f400c901fb00109b160076108a10791068105710461035443012c87f01ca0055b050bccb3f19ce17ce15ce03c8ce58fa02cb0f12cb3f12cb3f12cb0712cb3f12cb07cdc9ed5401fc8e785b320ad33f308200a4e3511abaf2f48200c6480bc0011bf2f48200ed4df84228c705917f95f84227c705e2f2f4816c8d29c103f2f474f8230aa4109b108a1079106810571046103540145033c87f01ca0055b050bccb3f19ce17ce15ce03c8ce58fa02cb0f12cb3f12cb3f12cb0712cb3f12cb07cdc9ed54e021c00518018ee3023dc0000cc1211cb08e3581253ff2f0109b5518c87f01ca0055b050bccb3f19ce17ce15ce03c8ce58fa02cb0f12cb3f12cb3f12cb0712cb3f12cb07cdc9ed54e05f0cf2c0821901fe5b0bd33fd31fd31f308200a4e3513dba13f2f48200f26e0ec0041ef2f4f84228c705f823248208127500a0bc0191308e1a81105801f2f48200a5c3f8422bc705917f95f8422ac705e2f2f4e28200f53753d1a0812710baf2f472541c0681271027a1a8812710a904520fa8812710a90450eda8812710a90453c0a08200d5571a01fcf8276f1002820afaf080a012bef2f42cc2008e247170c8c92c0411105520441359c8cf8580ca00cf8440ce01fa02806acf40f400c901fb00913ce22bc2008e237170c8c92c040f5520441359c8cf8580ca00cf8440ce01fa02806acf40f400c901fb00913be27081008270c8c9295530441359c8cf8580ca00cf8440ce011b0078fa02806acf40f400c901fb00109b5518c87f01ca0055b050bccb3f19ce17ce15ce03c8ce58fa02cb0f12cb3f12cb3f12cb0712cb3f12cb07cdc9ed54895f7ba9');
    const builder = beginCell();
    builder.storeUint(0, 1);
    initDealEscrow_init_args({ $$type: 'DealEscrow_init_args', dealId, advertiser, publisher, arbiter, feeReceiver, platformFeeBps, expectedAmount, refundDeadline })(builder);
    const __data = builder.endCell();
    return { code: __code, data: __data };
}

export const DealEscrow_errors = {
    2: { message: "Stack underflow" },
    3: { message: "Stack overflow" },
    4: { message: "Integer overflow" },
    5: { message: "Integer out of expected range" },
    6: { message: "Invalid opcode" },
    7: { message: "Type check error" },
    8: { message: "Cell overflow" },
    9: { message: "Cell underflow" },
    10: { message: "Dictionary error" },
    11: { message: "'Unknown' error" },
    12: { message: "Fatal error" },
    13: { message: "Out of gas error" },
    14: { message: "Virtualization error" },
    32: { message: "Action list is invalid" },
    33: { message: "Action list is too long" },
    34: { message: "Action is invalid or not supported" },
    35: { message: "Invalid source address in outbound message" },
    36: { message: "Invalid destination address in outbound message" },
    37: { message: "Not enough Toncoin" },
    38: { message: "Not enough extra currencies" },
    39: { message: "Outbound message does not fit into a cell after rewriting" },
    40: { message: "Cannot process a message" },
    41: { message: "Library reference is null" },
    42: { message: "Library change action error" },
    43: { message: "Exceeded maximum number of cells in the library or the maximum depth of the Merkle tree" },
    50: { message: "Account state size exceeded limits" },
    128: { message: "Null reference exception" },
    129: { message: "Invalid serialization prefix" },
    130: { message: "Invalid incoming message" },
    131: { message: "Constraints error" },
    132: { message: "Access denied" },
    133: { message: "Contract stopped" },
    134: { message: "Invalid argument" },
    135: { message: "Code of a contract was not found" },
    136: { message: "Invalid standard address" },
    138: { message: "Not a basechain address" },
    4184: { message: "Only arbiter can resolve before timeout" },
    9535: { message: "Plain transfer disabled" },
    10300: { message: "Not authorized to refund" },
    17062: { message: "Invalid amount" },
    27392: { message: "Already funded" },
    27789: { message: "Too many disputes" },
    27837: { message: "Invalid fee" },
    37854: { message: "Amount below expected" },
    42211: { message: "Wrong deal ID" },
    42435: { message: "Not authorized" },
    46136: { message: "Fee too high" },
    50760: { message: "Not funded or already processed" },
    54615: { message: "Insufficient balance" },
    59612: { message: "Only advertiser can fund" },
    60749: { message: "Not a party" },
    62062: { message: "Not disputed" },
    62775: { message: "Shares must sum to 100%" },
    63320: { message: "Only platform can create deals" },
} as const

export const DealEscrow_errors_backward = {
    "Stack underflow": 2,
    "Stack overflow": 3,
    "Integer overflow": 4,
    "Integer out of expected range": 5,
    "Invalid opcode": 6,
    "Type check error": 7,
    "Cell overflow": 8,
    "Cell underflow": 9,
    "Dictionary error": 10,
    "'Unknown' error": 11,
    "Fatal error": 12,
    "Out of gas error": 13,
    "Virtualization error": 14,
    "Action list is invalid": 32,
    "Action list is too long": 33,
    "Action is invalid or not supported": 34,
    "Invalid source address in outbound message": 35,
    "Invalid destination address in outbound message": 36,
    "Not enough Toncoin": 37,
    "Not enough extra currencies": 38,
    "Outbound message does not fit into a cell after rewriting": 39,
    "Cannot process a message": 40,
    "Library reference is null": 41,
    "Library change action error": 42,
    "Exceeded maximum number of cells in the library or the maximum depth of the Merkle tree": 43,
    "Account state size exceeded limits": 50,
    "Null reference exception": 128,
    "Invalid serialization prefix": 129,
    "Invalid incoming message": 130,
    "Constraints error": 131,
    "Access denied": 132,
    "Contract stopped": 133,
    "Invalid argument": 134,
    "Code of a contract was not found": 135,
    "Invalid standard address": 136,
    "Not a basechain address": 138,
    "Only arbiter can resolve before timeout": 4184,
    "Plain transfer disabled": 9535,
    "Not authorized to refund": 10300,
    "Invalid amount": 17062,
    "Already funded": 27392,
    "Too many disputes": 27789,
    "Invalid fee": 27837,
    "Amount below expected": 37854,
    "Wrong deal ID": 42211,
    "Not authorized": 42435,
    "Fee too high": 46136,
    "Not funded or already processed": 50760,
    "Insufficient balance": 54615,
    "Only advertiser can fund": 59612,
    "Not a party": 60749,
    "Not disputed": 62062,
    "Shares must sum to 100%": 62775,
    "Only platform can create deals": 63320,
} as const

const DealEscrow_types: ABIType[] = [
    {"name":"DataSize","header":null,"fields":[{"name":"cells","type":{"kind":"simple","type":"int","optional":false,"format":257}},{"name":"bits","type":{"kind":"simple","type":"int","optional":false,"format":257}},{"name":"refs","type":{"kind":"simple","type":"int","optional":false,"format":257}}]},
    {"name":"SignedBundle","header":null,"fields":[{"name":"signature","type":{"kind":"simple","type":"fixed-bytes","optional":false,"format":64}},{"name":"signedData","type":{"kind":"simple","type":"slice","optional":false,"format":"remainder"}}]},
    {"name":"StateInit","header":null,"fields":[{"name":"code","type":{"kind":"simple","type":"cell","optional":false}},{"name":"data","type":{"kind":"simple","type":"cell","optional":false}}]},
    {"name":"Context","header":null,"fields":[{"name":"bounceable","type":{"kind":"simple","type":"bool","optional":false}},{"name":"sender","type":{"kind":"simple","type":"address","optional":false}},{"name":"value","type":{"kind":"simple","type":"int","optional":false,"format":257}},{"name":"raw","type":{"kind":"simple","type":"slice","optional":false}}]},
    {"name":"SendParameters","header":null,"fields":[{"name":"mode","type":{"kind":"simple","type":"int","optional":false,"format":257}},{"name":"body","type":{"kind":"simple","type":"cell","optional":true}},{"name":"code","type":{"kind":"simple","type":"cell","optional":true}},{"name":"data","type":{"kind":"simple","type":"cell","optional":true}},{"name":"value","type":{"kind":"simple","type":"int","optional":false,"format":257}},{"name":"to","type":{"kind":"simple","type":"address","optional":false}},{"name":"bounce","type":{"kind":"simple","type":"bool","optional":false}}]},
    {"name":"MessageParameters","header":null,"fields":[{"name":"mode","type":{"kind":"simple","type":"int","optional":false,"format":257}},{"name":"body","type":{"kind":"simple","type":"cell","optional":true}},{"name":"value","type":{"kind":"simple","type":"int","optional":false,"format":257}},{"name":"to","type":{"kind":"simple","type":"address","optional":false}},{"name":"bounce","type":{"kind":"simple","type":"bool","optional":false}}]},
    {"name":"DeployParameters","header":null,"fields":[{"name":"mode","type":{"kind":"simple","type":"int","optional":false,"format":257}},{"name":"body","type":{"kind":"simple","type":"cell","optional":true}},{"name":"value","type":{"kind":"simple","type":"int","optional":false,"format":257}},{"name":"bounce","type":{"kind":"simple","type":"bool","optional":false}},{"name":"init","type":{"kind":"simple","type":"StateInit","optional":false}}]},
    {"name":"StdAddress","header":null,"fields":[{"name":"workchain","type":{"kind":"simple","type":"int","optional":false,"format":8}},{"name":"address","type":{"kind":"simple","type":"uint","optional":false,"format":256}}]},
    {"name":"VarAddress","header":null,"fields":[{"name":"workchain","type":{"kind":"simple","type":"int","optional":false,"format":32}},{"name":"address","type":{"kind":"simple","type":"slice","optional":false}}]},
    {"name":"BasechainAddress","header":null,"fields":[{"name":"hash","type":{"kind":"simple","type":"int","optional":true,"format":257}}]},
    {"name":"ChangeOwner","header":2174598809,"fields":[{"name":"queryId","type":{"kind":"simple","type":"uint","optional":false,"format":64}},{"name":"newOwner","type":{"kind":"simple","type":"address","optional":false}}]},
    {"name":"ChangeOwnerOk","header":846932810,"fields":[{"name":"queryId","type":{"kind":"simple","type":"uint","optional":false,"format":64}},{"name":"newOwner","type":{"kind":"simple","type":"address","optional":false}}]},
    {"name":"Fund","header":1,"fields":[{"name":"dealId","type":{"kind":"simple","type":"uint","optional":false,"format":64}}]},
    {"name":"Release","header":2,"fields":[{"name":"dealId","type":{"kind":"simple","type":"uint","optional":false,"format":64}}]},
    {"name":"Refund","header":3,"fields":[{"name":"dealId","type":{"kind":"simple","type":"uint","optional":false,"format":64}}]},
    {"name":"Dispute","header":4,"fields":[{"name":"dealId","type":{"kind":"simple","type":"uint","optional":false,"format":64}},{"name":"reason","type":{"kind":"simple","type":"string","optional":false}}]},
    {"name":"ResolveDispute","header":5,"fields":[{"name":"dealId","type":{"kind":"simple","type":"uint","optional":false,"format":64}},{"name":"publisherShare","type":{"kind":"simple","type":"uint","optional":false,"format":32}},{"name":"advertiserShare","type":{"kind":"simple","type":"uint","optional":false,"format":32}}]},
    {"name":"UpdatePlatformFee","header":6,"fields":[{"name":"newFeeBps","type":{"kind":"simple","type":"uint","optional":false,"format":16}}]},
    {"name":"UpdateBackendWallet","header":7,"fields":[{"name":"newBackendWallet","type":{"kind":"simple","type":"address","optional":false}}]},
    {"name":"CreateEscrow","header":8,"fields":[]},
    {"name":"DeployEscrow","header":9,"fields":[{"name":"queryId","type":{"kind":"simple","type":"uint","optional":false,"format":64}}]},
    {"name":"DealInfo","header":null,"fields":[{"name":"advertiser","type":{"kind":"simple","type":"address","optional":false}},{"name":"publisher","type":{"kind":"simple","type":"address","optional":false}},{"name":"amount","type":{"kind":"simple","type":"uint","optional":false,"format":"coins"}},{"name":"platformFee","type":{"kind":"simple","type":"uint","optional":false,"format":"coins"}},{"name":"publisherAmount","type":{"kind":"simple","type":"uint","optional":false,"format":"coins"}},{"name":"fundedAt","type":{"kind":"simple","type":"uint","optional":false,"format":64}},{"name":"status","type":{"kind":"simple","type":"uint","optional":false,"format":8}}]},
    {"name":"EscrowFactory$Data","header":null,"fields":[{"name":"owner","type":{"kind":"simple","type":"address","optional":false}},{"name":"platformWallet","type":{"kind":"simple","type":"address","optional":false}},{"name":"backendWallet","type":{"kind":"simple","type":"address","optional":false}},{"name":"platformFeeBps","type":{"kind":"simple","type":"uint","optional":false,"format":16}},{"name":"minFee","type":{"kind":"simple","type":"uint","optional":false,"format":"coins"}},{"name":"totalDeals","type":{"kind":"simple","type":"uint","optional":false,"format":64}}]},
    {"name":"DealEscrow$Data","header":null,"fields":[{"name":"dealId","type":{"kind":"simple","type":"uint","optional":false,"format":64}},{"name":"advertiser","type":{"kind":"simple","type":"address","optional":false}},{"name":"publisher","type":{"kind":"simple","type":"address","optional":false}},{"name":"arbiter","type":{"kind":"simple","type":"address","optional":false}},{"name":"feeReceiver","type":{"kind":"simple","type":"address","optional":false}},{"name":"amount","type":{"kind":"simple","type":"uint","optional":false,"format":"coins"}},{"name":"platformFeeBps","type":{"kind":"simple","type":"uint","optional":false,"format":16}},{"name":"fundedAt","type":{"kind":"simple","type":"uint","optional":false,"format":64}},{"name":"disputedAt","type":{"kind":"simple","type":"uint","optional":false,"format":64}},{"name":"disputeCount","type":{"kind":"simple","type":"uint","optional":false,"format":8}},{"name":"refundDeadline","type":{"kind":"simple","type":"uint","optional":false,"format":64}},{"name":"status","type":{"kind":"simple","type":"uint","optional":false,"format":8}}]},
]

const DealEscrow_opcodes = {
    "ChangeOwner": 2174598809,
    "ChangeOwnerOk": 846932810,
    "Fund": 1,
    "Release": 2,
    "Refund": 3,
    "Dispute": 4,
    "ResolveDispute": 5,
    "UpdatePlatformFee": 6,
    "UpdateBackendWallet": 7,
    "CreateEscrow": 8,
    "DeployEscrow": 9,
}

const DealEscrow_getters: ABIGetter[] = [
    {"name":"dealInfo","methodId":123235,"arguments":[],"returnType":{"kind":"simple","type":"DealInfo","optional":false}},
    {"name":"status","methodId":101642,"arguments":[],"returnType":{"kind":"simple","type":"int","optional":false,"format":257}},
    {"name":"balance","methodId":104128,"arguments":[],"returnType":{"kind":"simple","type":"int","optional":false,"format":257}},
    {"name":"arbiter","methodId":105631,"arguments":[],"returnType":{"kind":"simple","type":"address","optional":false}},
    {"name":"feeReceiver","methodId":87774,"arguments":[],"returnType":{"kind":"simple","type":"address","optional":false}},
]

export const DealEscrow_getterMapping: { [key: string]: string } = {
    'dealInfo': 'getDealInfo',
    'status': 'getStatus',
    'balance': 'getBalance',
    'arbiter': 'getArbiter',
    'feeReceiver': 'getFeeReceiver',
}

const DealEscrow_receivers: ABIReceiver[] = [
    {"receiver":"internal","message":{"kind":"empty"}},
    {"receiver":"internal","message":{"kind":"typed","type":"DeployEscrow"}},
    {"receiver":"internal","message":{"kind":"typed","type":"Fund"}},
    {"receiver":"internal","message":{"kind":"typed","type":"Release"}},
    {"receiver":"internal","message":{"kind":"typed","type":"Refund"}},
    {"receiver":"internal","message":{"kind":"typed","type":"Dispute"}},
    {"receiver":"internal","message":{"kind":"typed","type":"ResolveDispute"}},
]

export const BPS_SCALE = 10000n;
export const MAX_PLATFORM_FEE_BPS = 2000n;
export const STATUS_CREATED = 0n;
export const STATUS_FUNDED = 1n;
export const STATUS_RELEASED = 2n;
export const STATUS_REFUNDED = 3n;
export const STATUS_DISPUTED = 4n;
export const MIN_BALANCE_RESERVE = 50000000n;
export const DISPUTE_TIMEOUT = 1209600n;
export const MIN_DEAL_AMOUNT = 100000000n;

export class DealEscrow implements Contract {
    
    public static readonly storageReserve = 0n;
    public static readonly errors = DealEscrow_errors_backward;
    public static readonly opcodes = DealEscrow_opcodes;
    
    static async init(dealId: bigint, advertiser: Address, publisher: Address, arbiter: Address, feeReceiver: Address, platformFeeBps: bigint, expectedAmount: bigint, refundDeadline: bigint) {
        return await DealEscrow_init(dealId, advertiser, publisher, arbiter, feeReceiver, platformFeeBps, expectedAmount, refundDeadline);
    }
    
    static async fromInit(dealId: bigint, advertiser: Address, publisher: Address, arbiter: Address, feeReceiver: Address, platformFeeBps: bigint, expectedAmount: bigint, refundDeadline: bigint) {
        const __gen_init = await DealEscrow_init(dealId, advertiser, publisher, arbiter, feeReceiver, platformFeeBps, expectedAmount, refundDeadline);
        const address = contractAddress(0, __gen_init);
        return new DealEscrow(address, __gen_init);
    }
    
    static fromAddress(address: Address) {
        return new DealEscrow(address);
    }
    
    readonly address: Address; 
    readonly init?: { code: Cell, data: Cell };
    readonly abi: ContractABI = {
        types:  DealEscrow_types,
        getters: DealEscrow_getters,
        receivers: DealEscrow_receivers,
        errors: DealEscrow_errors,
    };
    
    constructor(address: Address, init?: { code: Cell, data: Cell }) {
        this.address = address;
        this.init = init;
    }
    
    async send(provider: ContractProvider, via: Sender, args: { value: bigint, bounce?: boolean| null | undefined }, message: null | DeployEscrow | Fund | Release | Refund | Dispute | ResolveDispute) {
        
        let body: Cell | null = null;
        if (message === null) {
            body = new Cell();
        }
        if (message && typeof message === 'object' && !(message instanceof Slice) && message.$$type === 'DeployEscrow') {
            body = beginCell().store(storeDeployEscrow(message)).endCell();
        }
        if (message && typeof message === 'object' && !(message instanceof Slice) && message.$$type === 'Fund') {
            body = beginCell().store(storeFund(message)).endCell();
        }
        if (message && typeof message === 'object' && !(message instanceof Slice) && message.$$type === 'Release') {
            body = beginCell().store(storeRelease(message)).endCell();
        }
        if (message && typeof message === 'object' && !(message instanceof Slice) && message.$$type === 'Refund') {
            body = beginCell().store(storeRefund(message)).endCell();
        }
        if (message && typeof message === 'object' && !(message instanceof Slice) && message.$$type === 'Dispute') {
            body = beginCell().store(storeDispute(message)).endCell();
        }
        if (message && typeof message === 'object' && !(message instanceof Slice) && message.$$type === 'ResolveDispute') {
            body = beginCell().store(storeResolveDispute(message)).endCell();
        }
        if (body === null) { throw new Error('Invalid message type'); }
        
        await provider.internal(via, { ...args, body: body });
        
    }
    
    async getDealInfo(provider: ContractProvider) {
        const builder = new TupleBuilder();
        const source = (await provider.get('dealInfo', builder.build())).stack;
        const result = loadGetterTupleDealInfo(source);
        return result;
    }
    
    async getStatus(provider: ContractProvider) {
        const builder = new TupleBuilder();
        const source = (await provider.get('status', builder.build())).stack;
        const result = source.readBigNumber();
        return result;
    }
    
    async getBalance(provider: ContractProvider) {
        const builder = new TupleBuilder();
        const source = (await provider.get('balance', builder.build())).stack;
        const result = source.readBigNumber();
        return result;
    }
    
    async getArbiter(provider: ContractProvider) {
        const builder = new TupleBuilder();
        const source = (await provider.get('arbiter', builder.build())).stack;
        const result = source.readAddress();
        return result;
    }
    
    async getFeeReceiver(provider: ContractProvider) {
        const builder = new TupleBuilder();
        const source = (await provider.get('feeReceiver', builder.build())).stack;
        const result = source.readAddress();
        return result;
    }
    
}