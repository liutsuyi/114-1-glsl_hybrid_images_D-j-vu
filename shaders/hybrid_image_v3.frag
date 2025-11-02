// Author: CMH
// Updated by: tsuyi
//
// 說明：這個 fragment shader 產生一個由三層合成的 hybrid image：
//   - lowpass (遠景) 來自 u_tex1，透過大核模糊得到
//   - midpass (中頻) 來自 u_tex2（外部提供的 band-pass/mid 圖），並乘上 u_midGain
//   - highpass (近景) 來自 u_tex0，經過高通/銳化處理與雜訊、遮罩微調
//
// Uniforms:
//   u_tex0 : sampler2D - 近景 (high-pass source)
//   u_tex1 : sampler2D - 遠景 (low-pass source)
//   u_tex2 : sampler2D - 中頻來源 (mid-pass image)
//   u_mask : sampler2D - 可選的遮罩或紋理，用於高頻處理
//   u_midGain : float  - mid 圖放大倍數（slider 可調）
//   u_lowWeight,u_midWeight,u_highWeight : float - 可由外部設定三層權重（若總和為 0 則使用滑鼠 Y 控制的預設權重）
//   u_original : sampler2D - 每組的原圖 (可透過 loadSet 設定)
//   u_showOriginal : float - 是否直接顯示原圖（>0.5 代表顯示原圖）
//
// 使用方式：前端用 GlslCanvas.setUniform() 設定以上 uniforms（例如在 UI 滑桿變動時傳入），
// 或在 HTML 的 data-textures 中預先指定三張貼圖 (u_tex0,u_tex1,u_tex2)。

#ifdef GL_ES
precision mediump float;
#endif

uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_time;
uniform sampler2D u_tex0; // High-pass source (near image)
uniform sampler2D u_tex1; // Low-pass source (far image)
uniform sampler2D u_tex2; // Mid-pass source (band image)
uniform sampler2D u_mask; // Masking pattern texture (e.g. paper grain, cloud)
// Controls (可由 JS 以 GlslCanvas.setUniform 設定)
uniform float u_midGain;    // mid 圖放大倍數
uniform float u_lowWeight;  // 手動低頻權重（若為 0 且三者和為 0，使用 mouse.y 的自動權重）
uniform float u_midWeight;  // 手動中頻權重
uniform float u_highWeight; // 手動高頻權重
// Original image toggle: 當 u_showOriginal > 0.5 時，直接輸出 u_original 的像素
uniform sampler2D u_original; // 原圖來源（每組可指定）
uniform float u_showOriginal; // 0.0 = normal hybrid, 1.0 = show original

void main() {
    
    // 1.Coordinate setup //
    vec2 st = gl_FragCoord.xy / u_resolution.xy;    
    vec2 uv = st; //[0~1]
    vec2 mouse = u_mouse.xy / u_resolution.xy;
    vec2 texel = 1.0 / u_resolution.xy;


    // 2.Define Multi-scale Gaussian kernels //
    float kernelSmall[9];
    kernelSmall[0] = 1.0/16.0; kernelSmall[1] = 2.0/16.0; kernelSmall[2] = 1.0/16.0;
    kernelSmall[3] = 2.0/16.0; kernelSmall[4] = 4.0/16.0; kernelSmall[5] = 2.0/16.0;
    kernelSmall[6] = 1.0/16.0; kernelSmall[7] = 2.0/16.0; kernelSmall[8] = 1.0/16.0;

    float kernelLarge[9];
    kernelLarge[0] = 1.0/64.0; kernelLarge[1] = 6.0/64.0; kernelLarge[2] = 1.0/64.0;
    kernelLarge[3] = 6.0/64.0; kernelLarge[4] = 36.0/64.0; kernelLarge[5] = 6.0/64.0;
    kernelLarge[6] = 1.0/64.0; kernelLarge[7] = 6.0/64.0; kernelLarge[8] = 1.0/64.0;

    vec2 offset[9];
    offset[0] = vec2(-1, -1);
    offset[1] = vec2( 0, -1);
    offset[2] = vec2( 1, -1);
    offset[3] = vec2(-1,  0);
    offset[4] = vec2( 0,  0);
    offset[5] = vec2( 1,  0);
    offset[6] = vec2(-1,  1);
    offset[7] = vec2( 0,  1);
    offset[8] = vec2( 1,  1);


    // 3. 低頻與中頻處理
    //    - 低頻 (lowpass) 採用較大核的模糊，代表遠景模糊信息
    //    - 中頻 (midpass) 由外部貼圖 u_tex2 提供（可以是事先計算的 DoG 圖或其他 band 圖），
    //      並以 u_midGain 控制強度；這讓中頻來源更有彈性（可替換或由後端預處理）
    //    備註：原先版本曾以 DoG(blurSmall - blurLarge) 計算 mid，但此處改為直接採樣 u_tex2
    vec3 blurSmall = vec3(0.0);
    vec3 blurLarge = vec3(0.0);
    for (int i = 0; i < 9; i++) {
        vec2 sampleUV = uv + offset[i] * texel;
        blurSmall += texture2D(u_tex1, sampleUV).rgb * kernelSmall[i];
        blurLarge += texture2D(u_tex1, sampleUV).rgb * kernelLarge[i];
    }
    // lowpass: use the larger-kernel blur (far background)
    vec3 lowpass = blurLarge;
    // midpass: use provided mid texture (u_tex2) as band image and apply gain
    float midGain = max(0.0, u_midGain);
    vec3 midpass = texture2D(u_tex2, uv).rgb * midGain;
  

    // 4.Step3: High-pass filter (for near-distance image u_tex0) //
    float strength = 1.5; // Increase this value for even stronger effect
    float kernel[9];
    kernel[0] = -1.0 * strength; kernel[1] = -1.0 * strength; kernel[2] = -1.0 * strength;
    kernel[3] = -1.0 * strength; kernel[4] =  8.0 * strength; kernel[5] = -1.0 * strength;
    kernel[6] = -1.0 * strength; kernel[7] = -1.0 * strength; kernel[8] = -1.0 * strength;
    vec3 highpass = vec3(0.0);
    for (int i = 0; i < 9; i++) {
        vec2 sampleUV = uv + offset[i] * texel;
        highpass += texture2D(u_tex0, sampleUV).rgb * kernel[i];
    }
        // 4.1 High-pass fine-tuning //
        vec3 mask = texture2D(u_mask, uv).rgb; // 取得遮罩紋理
        float maskWeight = 1.0 - mouse.x; // 畫面x向控制：遠距離融合為背景噪音，近距離減弱高頻清晰感
        highpass = mix(highpass, highpass * mask, maskWeight); // 應用遮罩紋理

        // 橘色區域加權保留
        float orangeMask = smoothstep(0.5, 1.0, highpass.r) * smoothstep(0.3, 1.0, highpass.g) * (1.0 - highpass.b);
        highpass = mix(highpass, highpass * vec3(1.3, 1.1, 0.9), orangeMask * 0.5); // 依照色彩區域加權

        // 加入白色噪點，減弱高頻深色輪廓線
        float grainScale = 80.0; // 顆粒粗細，數值越大越細
        float noise = fract(sin(dot(uv ,vec2(12.9898,78.233))) * 43758.5453); // 產生白色噪點
        vec3 whiteNoise = vec3(noise);
        float noiseStrength = 0.2; // 可調整噪點強度，0~0.5
        highpass = mix(highpass, whiteNoise, noiseStrength * (1.0 - highpass.g)); // 噪點只影響較暗的區域
        
        // 可調強度的高頻模糊（blur）
        float blurStrength = 0.4; // 可調整模糊強度，0~0.7
        vec3 blur = vec3(0.0);
        float blurKernel[9];
        blurKernel[0]=1.0/16.0; blurKernel[1]=2.0/16.0; blurKernel[2]=1.0/16.0;
        blurKernel[3]=2.0/16.0; blurKernel[4]=4.0/16.0; blurKernel[5]=2.0/16.0;
        blurKernel[6]=1.0/16.0; blurKernel[7]=2.0/16.0; blurKernel[8]=1.0/16.0;
        vec2 blurOffset[9];
        blurOffset[0]=vec2(-1,-1); blurOffset[1]=vec2(0,-1); blurOffset[2]=vec2(1,-1);
        blurOffset[3]=vec2(-1,0);  blurOffset[4]=vec2(0,0);  blurOffset[5]=vec2(1,0);
        blurOffset[6]=vec2(-1,1);  blurOffset[7]=vec2(0,1);  blurOffset[8]=vec2(1,1);
        for(int i=0;i<9;i++){
            blur += texture2D(u_tex0, uv + blurOffset[i]*texel).rgb * blurKernel[i];
        }
        highpass = mix(highpass, blur, blurStrength);


    // 5. 合成 (low / mid / high)
    //    支援兩種權重來源：
    //      1) 手動權重：若 u_lowWeight+u_midWeight+u_highWeight > 0，則使用這三個 uniforms（並正規化）
    //      2) 自動權重：若未設定手動權重，則回退到以滑鼠 y 座標計算的預設混合比例（舊行為）
    // We allow manual weights (via uniforms) or fallback to mouse-driven weights.
    float lowpassWeight;
    float midpassWeight;
    float highpassWeight;
    float manualSum = u_lowWeight + u_midWeight + u_highWeight;
    if (manualSum > 0.0001) {
        // use normalized manual weights
        lowpassWeight = u_lowWeight / manualSum;
        midpassWeight = u_midWeight / manualSum;
        highpassWeight = u_highWeight / manualSum;
    } else {
        // fallback: mouse-driven blending (legacy behavior)
        lowpassWeight = 1.0 - 0.5 * mouse.y; // 畫面 y 向控制：遠近混合比例
        highpassWeight = mouse.y + 0.2;
        midpassWeight = 1.0 - lowpassWeight - highpassWeight;
        if (midpassWeight < 0.0) midpassWeight = 0.0;
        // Normalize weights so they sum to 1 (prevents over/under exposure)
        float wsum = lowpassWeight + midpassWeight + highpassWeight;
        if (wsum > 0.0) {
            lowpassWeight /= wsum;
            midpassWeight /= wsum;
            highpassWeight /= wsum;
        }
    }

    // Optionally tint or clamp midpass to avoid large color shifts
    float midClamp = 2.0; // prevent extreme midpass amplification
    midpass = clamp(midpass, -vec3(midClamp), vec3(midClamp));

    vec3 hybrid = lowpass * lowpassWeight + midpass * midpassWeight + highpass * highpassWeight;
    
    
    // 如果開啟顯示原圖（u_showOriginal > 0.5），直接輸出 u_original 的像素；否則輸出 hybrid
    if (u_showOriginal > 0.5) {
        vec3 org = texture2D(u_original, uv).rgb;
        gl_FragColor = vec4(org, 1.0);
    } else {
        // Output final hybrid image //
        gl_FragColor = vec4(hybrid, 1.0);
    }
}