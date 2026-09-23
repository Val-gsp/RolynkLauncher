"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MicrosoftAuth = exports.MCInfoState = void 0;
const RestResponse_1 = require("../../common/rest/RestResponse");
const LoggerUtil_1 = require("../../util/LoggerUtil");
const got_1 = __importStar(require("got"));
const MicrosoftResponse_1 = require("./MicrosoftResponse");
var MCInfoState;
(function (MCInfoState) {
    MCInfoState["ACTIVE"] = "ACTIVE";
    MCInfoState["INACTIVE"] = "INACTIVE";
})(MCInfoState || (exports.MCInfoState = MCInfoState = {}));
/* ***********************************/
/*         Microsoft Auth API        */
/* ***********************************/
class MicrosoftAuth {
    static logger = LoggerUtil_1.LoggerUtil.getLogger('MicrosoftAuth');
    static TIMEOUT = 2500;
    static TOKEN_ENDPOINT = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
    static XBL_AUTH_ENDPOINT = 'https://user.auth.xboxlive.com/user/authenticate';
    static XSTS_AUTH_ENDPOINT = 'https://xsts.auth.xboxlive.com/xsts/authorize';
    static MC_AUTH_ENDPOINT = 'https://api.minecraftservices.com/authentication/login_with_xbox';
    static MC_ENTITLEMENT_ENDPOINT = 'https://api.minecraftservices.com/entitlements/mcstore';
    static MC_PROFILE_ENDPOINT = 'https://api.minecraftservices.com/minecraft/profile';
    static STANDARD_HEADERS = {
        'Content-Type': 'application/json',
        Accept: 'application/json'
    };
    /**
     * MicrosoftAuthAPI implementation of handleGotError. This function will additionally
     * analyze the response from Microsoft and populate the microsoft-specific error information.
     *
     * @param operation The operation name, for logging purposes.
     * @param error The error that occurred.
     * @param dataProvider A function to provide a response body.
     * @returns A MicrosoftResponse configured with error information.
     */
    static handleGotError(operation, error, dataProvider) {
        const response = (0, RestResponse_1.handleGotError)(operation, error, MicrosoftAuth.logger, dataProvider);
        if (error instanceof got_1.HTTPError) {
            if (error.response.statusCode === 404 && error.request.requestUrl === MicrosoftAuth.MC_PROFILE_ENDPOINT) {
                response.microsoftErrorCode = MicrosoftResponse_1.MicrosoftErrorCode.NO_PROFILE;
            }
            else {
                response.microsoftErrorCode = (0, MicrosoftResponse_1.decipherErrorCode)(error.response.body);
            }
        }
        else {
            response.microsoftErrorCode = MicrosoftResponse_1.MicrosoftErrorCode.UNKNOWN;
        }
        return response;
    }
    /**
     * Acquire a Microsoft Access Token, either for the first time or through refreshing an existing token.
     *
     * @param code Authorization Code or Refresh Token
     * @param refresh True if this is a refresh, false otherwise.
     * @param clientId The Azure Application (client) ID.
     * @returns A MicrosoftResponse for this operation.
     *
     * @see https://wiki.vg/Microsoft_Authentication_Scheme#Authorization_Code_-.3E_Authorization_Token
     * @see https://wiki.vg/Microsoft_Authentication_Scheme#Refreshing_Tokens
     */
    static async getAccessToken(code, refresh, clientId, codeVerifier) {
        try {
            const BASE_FORM = {
                client_id: clientId,
                scope: 'XboxLive.signin offline_access',
                redirect_uri: 'https://login.microsoftonline.com/common/oauth2/nativeclient',
            };
            let form;
            if (refresh) {
                form = {
                    ...BASE_FORM,
                    refresh_token: code,
                    grant_type: 'refresh_token'
                };
            }
            else {
                if (!codeVerifier) throw new Error('PKCE verifier required');
                form = {
                    ...BASE_FORM,
                    code: code,
                    code_verifier: codeVerifier,
                    grant_type: 'authorization_code'
                };
            }
            const res = await got_1.default.post(this.TOKEN_ENDPOINT, {
                form,
                responseType: 'json'
            });
            return {
                data: res.body,
                responseStatus: RestResponse_1.RestResponseStatus.SUCCESS
            };
        }
        catch (error) {
            return MicrosoftAuth.handleGotError(`Get ${refresh ? 'Refresh' : 'Auth'} Token`, error, () => null);
        }
    }
    /**
     * Authenticate with Xbox Live with a Microsoft Access Token.
     *
     * @param accessToken A Microsoft Access Token, from getAccessToken.
     * @returns A MicrosoftResponse for this operation.
     *
     * @see https://wiki.vg/Microsoft_Authentication_Scheme#Authenticate_with_XBL
     */
    static async getXBLToken(accessToken) {
        try {
            // TODO TYPE REQUEST
            const res = await got_1.default.post(this.XBL_AUTH_ENDPOINT, {
                json: {
                    Properties: {
                        AuthMethod: 'RPS',
                        SiteName: 'user.auth.xboxlive.com',
                        RpsTicket: `d=${accessToken}`
                    },
                    RelyingParty: 'http://auth.xboxlive.com',
                    TokenType: 'JWT'
                },
                headers: MicrosoftAuth.STANDARD_HEADERS,
                responseType: 'json'
            });
            return {
                data: res.body,
                responseStatus: RestResponse_1.RestResponseStatus.SUCCESS
            };
        }
        catch (error) {
            return MicrosoftAuth.handleGotError('Get XBL Token', error, () => null);
        }
    }
    /**
     * Acquire an Xbox Secure Token Service (XSTS) Token.
     *
     * @param xblResponse An Xbox Live token response, from getXBLToken.
     * @returns A MicrosoftResponse for this operation.
     *
     * @see https://wiki.vg/Microsoft_Authentication_Scheme#Authenticate_with_XSTS
     */
    static async getXSTSToken(xblResponse) {
        try {
            // TODO TYPE REQUEST
            const res = await got_1.default.post(this.XSTS_AUTH_ENDPOINT, {
                json: {
                    Properties: {
                        SandboxId: 'RETAIL',
                        UserTokens: [xblResponse.Token]
                    },
                    RelyingParty: 'rp://api.minecraftservices.com/',
                    TokenType: 'JWT'
                },
                headers: MicrosoftAuth.STANDARD_HEADERS,
                responseType: 'json'
            });
            return {
                data: res.body,
                responseStatus: RestResponse_1.RestResponseStatus.SUCCESS
            };
        }
        catch (error) {
            return MicrosoftAuth.handleGotError('Get XSTS Token', error, () => null);
        }
    }
    /**
     * Authenticate with Minecraft.
     *
     * @param xstsResponse An Xbox Secure Token Service (XSTS) Token response, from getXSTSToken.
     * @returns A MicrosoftResponse for this operation.
     *
     * @see https://wiki.vg/Microsoft_Authentication_Scheme#Authenticate_with_Minecraft
     */
    static async getMCAccessToken(xstsResponse) {
        try {
            // TODO TYPE REQUEST
            const res = await got_1.default.post(this.MC_AUTH_ENDPOINT, {
                json: {
                    identityToken: `XBL3.0 x=${xstsResponse.DisplayClaims.xui[0].uhs};${xstsResponse.Token}`
                },
                headers: MicrosoftAuth.STANDARD_HEADERS,
                responseType: 'json'
            });
            return {
                data: res.body,
                responseStatus: RestResponse_1.RestResponseStatus.SUCCESS
            };
        }
        catch (error) {
            return MicrosoftAuth.handleGotError('Get MC Access Token', error, () => null);
        }
    }
    // TODO Review https://wiki.vg/Microsoft_Authentication_Scheme#Checking_Game_Ownership
    // Cannot detect Xbox Game Pass users, so what good is this? Should we implement it just cause..?
    // public static async checkEntitlement(accessToken: string): Promise<MicrosoftResponse<unknown | null>> {
    //     try {
    //         const res = await got.get<unknown>(this.MC_ENTITLEMENT_ENDPOINT, {
    //             headers: {
    //                 Authorization: `Bearer ${accessToken}`
    //             },
    //             responseType: 'json'
    //         })
    //         return {
    //             data: res.body,
    //             responseStatus: RestResponseStatus.SUCCESS
    //         }
    //     } catch(error) {
    //         return MicrosoftAuth.handleGotError('Check Entitlement', error as RequestError, () => null)
    //     }
    // }
    /**
     * Get MC Profile Data, specifically account name and uuid.
     *
     * @param mcAccessToken A Minecraft Access Token, from getMCAccessToken.
     * @returns A MicrosoftResponse for this operation.
     *
     * @see https://wiki.vg/Microsoft_Authentication_Scheme#Get_the_profile
     */
    static async getMCProfile(mcAccessToken) {
        try {
            const res = await got_1.default.get(this.MC_PROFILE_ENDPOINT, {
                headers: {
                    Authorization: `Bearer ${mcAccessToken}`
                },
                responseType: 'json'
            });
            return {
                data: res.body,
                responseStatus: RestResponse_1.RestResponseStatus.SUCCESS
            };
        }
        catch (error) {
            return MicrosoftAuth.handleGotError('Get MC Profile', error, () => null);
        }
    }
}
exports.MicrosoftAuth = MicrosoftAuth;
