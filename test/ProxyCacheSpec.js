"use strict";
var expect = require('chai').expect,
    ProxyCache = require('../lib/ProxyCache'),
    adapter = require('../lib/adapters/proxy-cache-ttl'),
    http = require('http'),
    Promise = require('bluebird'),
    request = Promise.promisifyAll(require('request')),
    MD = require('mobile-detect');

describe("ProxyCache.js", function () {
    describe("A proxyCache instance", function(){
        var proxyCache,
            proxyCacheServer,
            timeout = 0,
            target = http.createServer(function(req, res){
                switch(req.url){
                    case '/emptyResponse':
                        res.end('');
                        break;
                    case '/hello':
                        res.end('hello');
                        break;
                    case '/mobileDetect':
                        timeout += 500; // every subsequent call will take longer to return
                        setTimeout(function(){
                            var md = new MD(req.headers['user-agent']),
                                device = ((md.phone())? 'phone' : 'not_phone');
                            res.end(device);
                        }, timeout);
                        break;
                    case '/code404':
                        res.statusCode = 404;
                        res.end('');
                        break;
                    case '/code500':
                        res.statusCode = 500;
                        res.end('');
                        break;
                    case '/delay':
                        setTimeout(function(){res.end('delayed')}, 1000);
                        break;
                    default:
                        throw new Error("UNEXPECTED URL");
                }
            }).listen(8801);

        beforeEach(function(ready){
            timeout = 0;

            if (proxyCacheServer) {
                proxyCacheServer.close();
            }

            proxyCache = new ProxyCache({
                adapter: adapter,
                targetHost: "localhost:8801",
                ignoreRegex: undefined
            });

            proxyCacheServer = http.createServer(function (req, res) {
                proxyCache.handleRequest(req, res);
            }).listen(8181);

            ready();
        });

        it("should not cache an empty response", function(done){
            request.getAsync('http://localhost:8181/emptyResponse')
                .then(function(res){
                    expect(proxyCache.cacheCollection["not_phone:localhost:8181:/emptyResponse"]).not.to.exist; // check that empty upstream responses are not cached
                    done();
                })
                .catch(function(err){
                    done(err);
                });
        });

        it("should not cache responses with HTTP codes > 200", function(done){
            Promise.all([
                    request.getAsync('http://localhost:8181/code404')
                        .then(function(res){
                            expect(proxyCache.cacheCollection["not_phone:localhost:8181:/code404"]).not.to.exist; // check that empty upstream responses are not cached
                        }),
                    request.getAsync('http://localhost:8181/code500')
                        .then(function(res){
                            expect(proxyCache.cacheCollection["not_phone:localhost:8181:/code500"]).not.to.exist; // check that empty upstream responses are not cached
                        })
                ])
                .then(function(res){
                    done();
                })
                .catch(function(err){
                    done(err);
                });
        });

        it("should cache the right device types (not_phone)", function(done){ // try to fool the server to cache a mobile site and serve it to desktop
            request.getAsync('http://localhost:8181/mobileDetect', {
                headers: {
                    'User-Agent': "Mozilla/5.0 (iPhone; CPU iPhone OS 8_0 like Mac OS X) AppleWebKit/600.1.3 (KHTML, like Gecko) Version/8.0 Mobile/12A4345d Safari/600.1.4"
                }
            });
            request.getAsync('http://localhost:8181/mobileDetect', {
                headers: {
                    'User-Agent': "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/43.0.2357.124 Safari/537.36"
                }
            })
                .then(function(res){
                    var co = proxyCache.cacheCollection["not_phone:localhost:8181:/mobileDetect"];
                    expect(co).to.exist;
                    expect(new Buffer(co.data, 'base64').toString()).to.equal("not_phone");
                    done();
                })
                .catch(function(err){
                    done(err);
                });
        });

        it("should cache the right device types (phone)", function(done){
            request.getAsync('http://localhost:8181/mobileDetect', {}); // try to fool the server to cache a desktop site and serve it to mobile
            request.getAsync('http://localhost:8181/mobileDetect', {headers: {
//                'User-Agent': "Mozilla/5.0 (iPhone; CPU iPhone OS 8_0 like Mac OS X) AppleWebKit/600.1.3 (KHTML, like Gecko) Version/8.0 Mobile/12A4345d Safari/600.1.4"
                'User-Agent': "Mozilla/5.0 (Linux; Android 5.0.2; SM-G9250 Build/LRX22G; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/43.0.2357.121 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/35.0.0.48.273;]" // MD detect fails to detect this as phone in versions > 0.4.3
            }})
                .then(function(res){
                    var co = proxyCache.cacheCollection["phone:localhost:8181:/mobileDetect"];
                    expect(co).to.exist;
                    expect(new Buffer(co.data, 'base64').toString()).to.equal("phone");
                    done();
                })
                .catch(function(err){
                    done(err);
                });
        });

        it("should be able to clear memory cache by calling `clearAll()`", function(done){
            request.getAsync('http://localhost:8181/hello', {})
                .then(function(res){
                    return request.getAsync('http://localhost:8181/hello', {})
                })
                .then(function(res2){
                    var co = proxyCache.cacheCollection["not_phone:localhost:8181:/hello"];
                    expect(co).to.exist;
                    expect(co.hits).to.equal(1);
                    proxyCache.clearAll();
                    expect(proxyCache.cacheCollection["not_phone:localhost:8181:/hello"]).not.to.exist;
                    done();
                })
                .catch(function(err){
                    done(err);
                });
        });

        it("should pool requests to the same URL", function(done){
            Promise.all([
                    request.getAsync('http://localhost:8181/delay', {}),
                    request.getAsync('http://localhost:8181/delay', {}),
                    request.getAsync('http://localhost:8181/delay', {}),
                    request.getAsync('http://localhost:8181/delay', {})
                ])
                .then(function(res){
                    done();
                })
                .catch(function(err){
                    done(err);
                });

            setTimeout(function checkCacheObjectPool(){
                //console.log(proxyCache.cacheCollection);
                var co = proxyCache.cacheCollection["not_phone:localhost:8181:/delay"];
                expect(co).to.exist;
                expect(co.pooled).to.be.greaterThan(0);
            }, 300);
        });

        it("should respond to all pooled requests when proxy response completes.", function(done){
            var request1 = request.getAsync('http://localhost:8181/delay')
                    .spread(function(res, body){
                        expect(body).to.equal('delayed');
                    }),
                request2 = request.getAsync('http://localhost:8181/delay')
                    .spread(function(res, body){
                        expect(body).to.equal('delayed');
                    });

            Promise.all([request1, request2])
                .then(function(){
                    done();
                })
                .catch(function(err){
                    done(err);
                });
        });
    });
});