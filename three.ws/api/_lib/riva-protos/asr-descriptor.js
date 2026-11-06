// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/generate-riva-asr-descriptor.mjs
// protobufjs JSON descriptor for the NVIDIA Riva ASR service, parsed
// (keepCase) from the vendored protos in api/_lib/riva-protos/*.proto,
// themselves from https://github.com/nvidia-riva/common (riva/proto/).
// SPDX-FileCopyrightText: Copyright (c) 2022 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT
export default {
	"nested": {
		"nvidia": {
			"nested": {
				"riva": {
					"options": {
						"cc_enable_arenas": true,
						"go_package": "nvidia.com/riva_speech"
					},
					"nested": {
						"RequestId": {
							"fields": {
								"value": {
									"type": "string",
									"id": 1
								}
							}
						},
						"AudioEncoding": {
							"values": {
								"ENCODING_UNSPECIFIED": 0,
								"LINEAR_PCM": 1,
								"FLAC": 2,
								"MULAW": 3,
								"OGGOPUS": 4,
								"ALAW": 20
							}
						},
						"asr": {
							"options": {
								"cc_enable_arenas": true,
								"go_package": "nvidia.com/riva_speech"
							},
							"nested": {
								"RivaSpeechRecognition": {
									"methods": {
										"Recognize": {
											"requestType": "RecognizeRequest",
											"responseType": "RecognizeResponse"
										},
										"StreamingRecognize": {
											"requestType": "StreamingRecognizeRequest",
											"requestStream": true,
											"responseType": "StreamingRecognizeResponse",
											"responseStream": true
										},
										"GetRivaSpeechRecognitionConfig": {
											"requestType": "RivaSpeechRecognitionConfigRequest",
											"responseType": "RivaSpeechRecognitionConfigResponse"
										}
									}
								},
								"RivaSpeechRecognitionConfigRequest": {
									"fields": {
										"model_name": {
											"type": "string",
											"id": 1
										}
									}
								},
								"RivaSpeechRecognitionConfigResponse": {
									"fields": {
										"model_config": {
											"rule": "repeated",
											"type": "Config",
											"id": 1
										}
									},
									"nested": {
										"Config": {
											"fields": {
												"model_name": {
													"type": "string",
													"id": 1
												},
												"parameters": {
													"keyType": "string",
													"type": "string",
													"id": 2
												}
											}
										}
									}
								},
								"RecognizeRequest": {
									"fields": {
										"config": {
											"type": "RecognitionConfig",
											"id": 1
										},
										"audio": {
											"type": "bytes",
											"id": 2
										},
										"id": {
											"type": "RequestId",
											"id": 100
										}
									}
								},
								"StreamingRecognizeRequest": {
									"oneofs": {
										"streaming_request": {
											"oneof": [
												"streaming_config",
												"audio_content"
											]
										}
									},
									"fields": {
										"streaming_config": {
											"type": "StreamingRecognitionConfig",
											"id": 1
										},
										"audio_content": {
											"type": "bytes",
											"id": 2
										},
										"runtime_config": {
											"keyType": "string",
											"type": "string",
											"id": 3
										},
										"id": {
											"type": "RequestId",
											"id": 100
										}
									}
								},
								"EndpointingConfig": {
									"oneofs": {
										"_start_history": {
											"oneof": [
												"start_history"
											]
										},
										"_start_threshold": {
											"oneof": [
												"start_threshold"
											]
										},
										"_stop_history": {
											"oneof": [
												"stop_history"
											]
										},
										"_stop_threshold": {
											"oneof": [
												"stop_threshold"
											]
										},
										"_stop_history_eou": {
											"oneof": [
												"stop_history_eou"
											]
										},
										"_stop_threshold_eou": {
											"oneof": [
												"stop_threshold_eou"
											]
										}
									},
									"fields": {
										"start_history": {
											"type": "int32",
											"id": 1,
											"options": {
												"proto3_optional": true
											}
										},
										"start_threshold": {
											"type": "float",
											"id": 2,
											"options": {
												"proto3_optional": true
											}
										},
										"stop_history": {
											"type": "int32",
											"id": 3,
											"options": {
												"proto3_optional": true
											}
										},
										"stop_threshold": {
											"type": "float",
											"id": 4,
											"options": {
												"proto3_optional": true
											}
										},
										"stop_history_eou": {
											"type": "int32",
											"id": 5,
											"options": {
												"proto3_optional": true
											}
										},
										"stop_threshold_eou": {
											"type": "float",
											"id": 6,
											"options": {
												"proto3_optional": true
											}
										}
									}
								},
								"RecognitionConfig": {
									"oneofs": {
										"_endpointing_config": {
											"oneof": [
												"endpointing_config"
											]
										}
									},
									"fields": {
										"encoding": {
											"type": "AudioEncoding",
											"id": 1
										},
										"sample_rate_hertz": {
											"type": "int32",
											"id": 2
										},
										"language_code": {
											"type": "string",
											"id": 3
										},
										"max_alternatives": {
											"type": "int32",
											"id": 4
										},
										"profanity_filter": {
											"type": "bool",
											"id": 5
										},
										"speech_contexts": {
											"rule": "repeated",
											"type": "SpeechContext",
											"id": 6
										},
										"audio_channel_count": {
											"type": "int32",
											"id": 7
										},
										"enable_word_time_offsets": {
											"type": "bool",
											"id": 8
										},
										"enable_automatic_punctuation": {
											"type": "bool",
											"id": 11
										},
										"enable_separate_recognition_per_channel": {
											"type": "bool",
											"id": 12
										},
										"model": {
											"type": "string",
											"id": 13
										},
										"verbatim_transcripts": {
											"type": "bool",
											"id": 14
										},
										"diarization_config": {
											"type": "SpeakerDiarizationConfig",
											"id": 19
										},
										"custom_configuration": {
											"keyType": "string",
											"type": "string",
											"id": 24
										},
										"endpointing_config": {
											"type": "EndpointingConfig",
											"id": 25,
											"options": {
												"proto3_optional": true
											}
										}
									}
								},
								"StreamingRecognitionConfig": {
									"fields": {
										"config": {
											"type": "RecognitionConfig",
											"id": 1
										},
										"interim_results": {
											"type": "bool",
											"id": 2
										}
									}
								},
								"SpeakerDiarizationConfig": {
									"fields": {
										"enable_speaker_diarization": {
											"type": "bool",
											"id": 1
										},
										"max_speaker_count": {
											"type": "int32",
											"id": 2
										}
									}
								},
								"SpeechContext": {
									"fields": {
										"phrases": {
											"rule": "repeated",
											"type": "string",
											"id": 1
										},
										"boost": {
											"type": "float",
											"id": 4
										}
									}
								},
								"RecognizeResponse": {
									"fields": {
										"results": {
											"rule": "repeated",
											"type": "SpeechRecognitionResult",
											"id": 1
										},
										"id": {
											"type": "RequestId",
											"id": 100
										}
									}
								},
								"SpeechRecognitionResult": {
									"fields": {
										"alternatives": {
											"rule": "repeated",
											"type": "SpeechRecognitionAlternative",
											"id": 1
										},
										"channel_tag": {
											"type": "int32",
											"id": 2
										},
										"audio_processed": {
											"type": "float",
											"id": 3
										}
									}
								},
								"SpeechRecognitionAlternative": {
									"fields": {
										"transcript": {
											"type": "string",
											"id": 1
										},
										"confidence": {
											"type": "float",
											"id": 2
										},
										"words": {
											"rule": "repeated",
											"type": "WordInfo",
											"id": 3
										},
										"language_code": {
											"rule": "repeated",
											"type": "string",
											"id": 4
										}
									}
								},
								"WordInfo": {
									"fields": {
										"start_time": {
											"type": "int32",
											"id": 1
										},
										"end_time": {
											"type": "int32",
											"id": 2
										},
										"word": {
											"type": "string",
											"id": 3
										},
										"confidence": {
											"type": "float",
											"id": 4
										},
										"speaker_tag": {
											"type": "int32",
											"id": 5
										},
										"language_code": {
											"type": "string",
											"id": 6
										}
									}
								},
								"StreamingRecognizeResponse": {
									"fields": {
										"results": {
											"rule": "repeated",
											"type": "StreamingRecognitionResult",
											"id": 1
										},
										"id": {
											"type": "RequestId",
											"id": 100
										}
									}
								},
								"PipelineStates": {
									"fields": {
										"vad_probabilities": {
											"rule": "repeated",
											"type": "float",
											"id": 1
										}
									}
								},
								"StreamingRecognitionResult": {
									"oneofs": {
										"_pipeline_states": {
											"oneof": [
												"pipeline_states"
											]
										}
									},
									"fields": {
										"alternatives": {
											"rule": "repeated",
											"type": "SpeechRecognitionAlternative",
											"id": 1
										},
										"is_final": {
											"type": "bool",
											"id": 2
										},
										"stability": {
											"type": "float",
											"id": 3
										},
										"channel_tag": {
											"type": "int32",
											"id": 5
										},
										"audio_processed": {
											"type": "float",
											"id": 6
										},
										"pipeline_states": {
											"type": "PipelineStates",
											"id": 7,
											"options": {
												"proto3_optional": true
											}
										}
									}
								}
							}
						}
					}
				}
			}
		}
	}
};
