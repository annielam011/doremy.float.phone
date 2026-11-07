package app.floatphone.shell

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream

/**
 * 原生录音器：当 WebView 的 getUserMedia 被系统拦截时（如 OPPO ColorOS），
 * 由壳直接用 AudioRecord 录音，绕过 WebView 的限制。
 *
 * 录音格式为 16-bit PCM，最终包装成 WAV 字节返回——WAV 是无损且所有
 * 语音转写 API（OpenAI Whisper 兼容接口）都支持的格式。
 */
class NativeAudioRecorder(private val context: Context) {

    companion object {
        private const val SAMPLE_RATE = 16000
        private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    }

    private var audioRecord: AudioRecord? = null
    private var recordingThread: Thread? = null

    @Volatile
    private var isRecording = false
    private val pcmBuffer = ByteArrayOutputStream()
    @Volatile private var latestRms = 0.0

    /** RMS 音量，供自由对话语音活动检测使用。 */
    fun getRms(): Double = latestRms

    /** 自由对话专用：按固定采样节拍保留最近 12 秒音频，避免静默时不断增大 WAV。 */
    @Synchronized
    fun startRolling(maxSeconds: Int = 12): Boolean {
        rollingMaxBytes = SAMPLE_RATE * 2 * maxSeconds.coerceIn(4, 30)
        rollingMode = true
        if (startInternal()) return true
        rollingMode = false
        return false
    }

    private var rollingMode = false
    private var rollingMaxBytes = SAMPLE_RATE * 2 * 12

    /**
     * 开始录音。
     * @return true=已开始；false=权限不足或设备不支持
     */
    @Synchronized
    fun start(): Boolean {
        rollingMode = false
        return startInternal()
    }

    private fun startInternal(): Boolean {
        if (isRecording) return true
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) return false

        val bufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        if (bufferSize == AudioRecord.ERROR || bufferSize == AudioRecord.ERROR_BAD_VALUE) return false

        val recorder = try {
            @Suppress("MissingPermission")
            AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, CHANNEL, ENCODING, bufferSize)
        } catch (_: Exception) {
            return false
        }

        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            return false
        }

        pcmBuffer.reset()
        latestRms = 0.0
        audioRecord = recorder
        isRecording = true

        recorder.startRecording()

        recordingThread = Thread({
            val buffer = ByteArray(bufferSize)
            while (isRecording) {
                val read = recorder.read(buffer, 0, buffer.size)
                if (read > 0) {
                    var sum = 0.0
                    var samples = 0
                    var i = 0
                    while (i + 1 < read) {
                        val sample = ((buffer[i + 1].toInt() shl 8) or (buffer[i].toInt() and 0xff)).toShort().toInt()
                        sum += sample.toDouble() * sample
                        samples++
                        i += 2
                    }
                    latestRms = if (samples > 0) kotlin.math.sqrt(sum / samples) else 0.0
                    synchronized(pcmBuffer) {
                        if (rollingMode && pcmBuffer.size() + read > rollingMaxBytes) {
                            val old = pcmBuffer.toByteArray()
                            pcmBuffer.reset()
                            val excess = (old.size + read - rollingMaxBytes).coerceAtMost(old.size)
                            pcmBuffer.write(old, excess, old.size - excess)
                        }
                        pcmBuffer.write(buffer, 0, read)
                    }
                }
            }
        }, "NativeAudioRecorder").apply { start() }

        return true
    }

    /**
     * 停止录音并返回 WAV 格式的 base64 字符串。
     * 没有录到有效内容时返回空串。
     */
    @Synchronized
    fun stopAndGetBase64(): String {
        if (!isRecording) {
            rollingMode = false
            latestRms = 0.0
            return ""
        }
        isRecording = false

        try { recordingThread?.join(2000) } catch (_: Exception) {}
        recordingThread = null

        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        rollingMode = false
        latestRms = 0.0

        val pcmData: ByteArray
        synchronized(pcmBuffer) { pcmData = pcmBuffer.toByteArray() }
        if (pcmData.isEmpty()) return ""

        val wav = pcmToWav(pcmData)
        return Base64.encodeToString(wav, Base64.NO_WRAP)
    }

    /** 取消录音，丢弃内容。 */
    @Synchronized
    fun cancel() {
        if (!isRecording) {
            rollingMode = false
            latestRms = 0.0
            pcmBuffer.reset()
            return
        }
        isRecording = false
        try { recordingThread?.join(2000) } catch (_: Exception) {}
        recordingThread = null
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        rollingMode = false
        latestRms = 0.0
        pcmBuffer.reset()
    }

    /** 把裸 PCM 数据包装成标准 WAV 文件字节。 */
    private fun pcmToWav(pcmData: ByteArray): ByteArray {
        val channels = 1
        val bitsPerSample = 16
        val byteRate = SAMPLE_RATE * channels * bitsPerSample / 8
        val blockAlign = channels * bitsPerSample / 8
        val dataSize = pcmData.size
        val totalSize = 36 + dataSize

        val header = ByteArray(44)
        // RIFF header
        header[0] = 'R'.code.toByte(); header[1] = 'I'.code.toByte()
        header[2] = 'F'.code.toByte(); header[3] = 'F'.code.toByte()
        writeInt(header, 4, totalSize)
        header[8] = 'W'.code.toByte(); header[9] = 'A'.code.toByte()
        header[10] = 'V'.code.toByte(); header[11] = 'E'.code.toByte()
        // fmt chunk
        header[12] = 'f'.code.toByte(); header[13] = 'm'.code.toByte()
        header[14] = 't'.code.toByte(); header[15] = ' '.code.toByte()
        writeInt(header, 16, 16) // chunk size
        writeShort(header, 20, 1) // PCM format
        writeShort(header, 22, channels)
        writeInt(header, 24, SAMPLE_RATE)
        writeInt(header, 28, byteRate)
        writeShort(header, 32, blockAlign)
        writeShort(header, 34, bitsPerSample)
        // data chunk
        header[36] = 'd'.code.toByte(); header[37] = 'a'.code.toByte()
        header[38] = 't'.code.toByte(); header[39] = 'a'.code.toByte()
        writeInt(header, 40, dataSize)

        return header + pcmData
    }

    private fun writeInt(buf: ByteArray, offset: Int, value: Int) {
        buf[offset] = (value and 0xFF).toByte()
        buf[offset + 1] = (value shr 8 and 0xFF).toByte()
        buf[offset + 2] = (value shr 16 and 0xFF).toByte()
        buf[offset + 3] = (value shr 24 and 0xFF).toByte()
    }

    private fun writeShort(buf: ByteArray, offset: Int, value: Int) {
        buf[offset] = (value and 0xFF).toByte()
        buf[offset + 1] = (value shr 8 and 0xFF).toByte()
    }
}
