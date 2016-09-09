/**
 * Created by liangjz on 4/8/16.
 */


import {
    setPromise,
    getPromise,
    eventListener,
    isObject,
    isPromise,
    assign
} from './utils';

let {addEventListener, removeEventListener} = eventListener();
let _uniqueId = 0;
let _requestPrefix = '__request-';
let _responsePrefix = '__response-';
let _requestReg = new RegExp('^(\\d+)' + _requestPrefix + '(.*)');
let _responseReg = new RegExp('^(\\d+)' + _responsePrefix + '(.*)');
let RESOLVED = 'resolved';
let REJECTED = 'rejected';
let _useQ = typeof Promise === 'function';
let _useDefer = false;

export class CrossMessage {

    /**
     * 在不支持Promise的browser里, 需要设置一个第三方的promise
     * @param Q
     */
    static usePromise(Q) {
        setPromise(Q);
        _useQ = typeof Q === 'function';
        _useDefer = typeof Q.defer === 'function';
    }

    /**
     * Using window.postMessage magic. See https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
     * @param options
     *        .otherWindow      需要通讯的目标窗口对象.
     *        .thisWindow       [optional] 默认为引用CrossMessage脚本的当前窗口对象
     *        .domain           [optional] 默认为'*'
     *        .knownWindowOnly  [optional] 如果设置为true, 则只接收'otherWindow'发来的消息. 默认为true
     */
    constructor(options = {}) {
        if (!getPromise()) {
            throw new Error('No "Promise" feature available in browser, must specify another promise lib');
        }

        if (!options.otherWindow) {
            throw new Error('Must specify "otherWindow" to communicate with');
        }

        options = assign({thisWindow: window, domain: '*', knownWindowOnly: true}, options);
        let thisWindow = this._thisWin = options.thisWindow;
        let otherWin = this._otherWin = options.otherWindow;
        let knownWindowOnly = !!options.knownWindowOnly;
        this._domain = options.domain;
        this._callbacks = {};
        this._promises = {};

        addEventListener(thisWindow, 'message', this._listener = (event) => {
            if (knownWindowOnly && otherWin !== event.source) {
                // Ignores the event doesn't belongs to this
                return;
            }

            if (!this._domain) {
                this._domain = event.origin || event.originalEvent.origin;
            }

            let eventData = event.data, matchRequest, matchResponse;
            if (!eventData.cm$type) {
                // Message does not belongs to cross-message
                return;
            }
            
            if (matchRequest = eventData.cm$type.match(_requestReg)) {
                this._handleReq(event, eventData, matchRequest[1], matchRequest[2]);
            } else if (matchResponse = eventData.cm$type.match(_responseReg)) {
                this._handleResp(event, eventData, matchResponse[1], matchResponse[2]);
            }
        });
    }

    /**
     * 向目标窗口'otherWindow'发送数据. 返回promise
     * @param event     Event name
     * @param data      String or object, 不能包含function
     * @returns {promise}
     *
     * promise返回的值格式为{status: xx, message: xx}
     */
    post(event, data) {
        let Q = getPromise();
        let _post = (resolve, reject) => {
            ++_uniqueId;
            this._otherWin.postMessage({
                cm$type: `${_uniqueId}${_requestPrefix}${event}`,
                cm$data: data
            }, this._domain);
            this._promises[`${_uniqueId}${event}`] = {
                resolve: resolve,
                reject: reject
            }
        };

        if (_useQ) {
            return new Q((resolve, reject) => {
                _post(resolve, reject);
            });
        }

        if (_useDefer) {
            let defer = Q.defer();
            _post(defer.resolve, defer.reject);
            return defer.promise;
        }

        throw new Error('Unknown promise.');
    }

    /**
     * 注册一个监听事件回调. 同一个事件只允许设置一个回调.
     * 此回调函数会接收一个参数, 即'otherWindow'通过post发出的data
     * @param event
     * @param fn
     *
     * fn必须返回一个值, 可以是以下值之一. 其中status有三种状态: resolved, rejected, notFound.
     * notFound是rejected的一种, 用于A向B通讯时, B中没有相应的处理事件的情况
     * - 任意一个包含status属性并且没有function value的对象: {status: 'resolved', message: 'xxxx'}
     *   如果没包含status属性, 则相当于 {status: 'resolved', message: theObject}
     * - true/false, 相当于 {status: 'resolved', message: true}/{status: 'rejected', message: false}
     * - promise: 这个promise必须resolve或reject以上值之一
     */
    on(event, fn) {
        this._callbacks[event] = fn;
    }

    /**
     * 注销事件监听. 如果不传入event, 则全部注销
     * @param event
     */
    off(event) {
        event ? delete this._callbacks[event] : this._callbacks = {};
    }

    /**
     * **重要**.
     * 如果不是在全局作用域使用CrossMessage, 在作用域销毁之前需要调用此方法.
     * 例如在一个SPA中, 在A子页面使用了CrossMessage, 在切换到其他页面之前(如果A子页面会被销毁), 需要调用此方法
     */
    clear() {
        removeEventListener(this._thisWin, 'message', this._listener);
    }

    _handleReq(event, eventData, id, eventName) {
        let cb = this._callbacks[eventName];
        
        // 没有相应的回调, 不处理
        if (typeof cb !== 'function') {
            return;
        }
        
        let result = cb(eventData.cm$data),
            cm$type = `${id}${_responsePrefix}${eventName}`,
            win = event.source, d = this._domain;
        // The callback returns a promise
        if (isPromise(result)) {
            result.then((realResult) => {
                win.postMessage({cm$type: cm$type, cm$data: {status: RESOLVED, message: realResult}}, d);
            }, (error) => {
                win.postMessage({cm$type: cm$type, cm$data: {status: REJECTED, message: error}}, d)
            });
            return;
        }
        // The callback returns with true/false
        else if (typeof result === 'boolean') {
            result = {status: result ? RESOLVED : REJECTED, message: result};
        }
        // Normal object.
        else {
            let status = result.status;
            result = typeof status === 'string' ? result : {status: RESOLVED, message: result};
        }
        win.postMessage({cm$type: cm$type, cm$data: result}, d);
    }

    _handleResp(event, eventData, id, eventName) {
        let cm$data = eventData.cm$data,
            method = cm$data.status.toLowerCase() === RESOLVED ? 'resolve' : 'reject',
            key = `${id}${eventName}`;
        if (this._promises[key]) {
            this._promises[key][method](cm$data.message);
            delete this._promises[key];
        }
    }
}

if (typeof window !== 'undefined') {
    window.CrossMessage = CrossMessage;
}
