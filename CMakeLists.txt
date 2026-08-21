cmake_minimum_required(VERSION 3.25)

project(chrome_control_mcp VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_AUTOMOC OFF)

option(ENABLE_ASAN_UBSAN "Enable AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
option(ENABLE_TSAN "Enable ThreadSanitizer" OFF)
if(ENABLE_ASAN_UBSAN AND ENABLE_TSAN)
    message(FATAL_ERROR "ENABLE_ASAN_UBSAN and ENABLE_TSAN cannot be combined")
endif()

function(enable_project_quality target)
    if(MSVC)
        target_compile_options(${target} PRIVATE /W4 /WX /permissive- /utf-8)
    elseif(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        target_compile_options(${target} PRIVATE
            -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion -Werror
        )
    endif()

    if(ENABLE_ASAN_UBSAN)
        if(MSVC)
            message(FATAL_ERROR "ENABLE_ASAN_UBSAN requires Clang or GCC")
        endif()
        target_compile_options(${target} PRIVATE
            -fsanitize=address,undefined -fno-omit-frame-pointer
            -fno-sanitize-recover=all
        )
        target_link_options(${target} PRIVATE
            -fsanitize=address,undefined -fno-sanitize-recover=all
        )
    elseif(ENABLE_TSAN)
        if(MSVC)
            message(FATAL_ERROR "ENABLE_TSAN requires Clang or GCC")
        endif()
        target_compile_options(${target} PRIVATE
            -fsanitize=thread -fno-omit-frame-pointer
            -fno-sanitize-recover=all
        )
        target_link_options(${target} PRIVATE
            -fsanitize=thread -fno-sanitize-recover=all
        )
    endif()
endfunction()

find_package(Qt6 6.5 REQUIRED COMPONENTS Core)
find_package(Threads REQUIRED)

set(CCMCP_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/include")
set(CCMCP_CORE_SOURCES
    src/browser_bridge.cpp
    src/browser_bridge_security.cpp
    src/browser_contract.cpp
    src/browser_control.cpp
    src/browser_extension_installer.cpp
    src/native_messaging.cpp
)

if(WIN32)
    set(CCMCP_BRIDGE_PIPE_SOURCE src/browser_bridge_pipe.cpp)
    set(CCMCP_BRIDGE_RELAY_SOURCE src/browser_bridge_relay.cpp)
else()
    set(CCMCP_BRIDGE_PIPE_SOURCE src/browser_bridge_pipe_posix.cpp)
    set(CCMCP_BRIDGE_RELAY_SOURCE src/browser_bridge_relay_posix.cpp)
endif()
list(APPEND CCMCP_CORE_SOURCES
    ${CCMCP_BRIDGE_PIPE_SOURCE}
    ${CCMCP_BRIDGE_RELAY_SOURCE}
)

add_library(chrome_control_mcp_core STATIC ${CCMCP_CORE_SOURCES})
target_include_directories(chrome_control_mcp_core PUBLIC ${CCMCP_INCLUDE_DIR})
target_link_libraries(chrome_control_mcp_core PUBLIC Qt6::Core Threads::Threads)
enable_project_quality(chrome_control_mcp_core)
if(WIN32)
    target_link_libraries(chrome_control_mcp_core PUBLIC advapi32 shell32 user32)
    target_compile_definitions(chrome_control_mcp_core PUBLIC UNICODE _UNICODE)
elseif(APPLE)
    target_link_libraries(chrome_control_mcp_core PRIVATE proc)
else()
    target_compile_definitions(chrome_control_mcp_core PRIVATE _GNU_SOURCE)
endif()

add_executable(chrome_control_mcp
    src/main.cpp
    src/browser_mcp_tools.cpp
    src/mcp_dispatch.cpp
    src/mcp_entry.cpp
)
target_include_directories(chrome_control_mcp PRIVATE ${CCMCP_INCLUDE_DIR})
target_link_libraries(chrome_control_mcp PRIVATE chrome_control_mcp_core Qt6::Core)
enable_project_quality(chrome_control_mcp)
if(WIN32)
    target_compile_definitions(chrome_control_mcp PRIVATE UNICODE _UNICODE)
endif()

add_custom_command(TARGET chrome_control_mcp POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CMAKE_CURRENT_SOURCE_DIR}/browser/extension"
            "$<TARGET_FILE_DIR:chrome_control_mcp>/extension"
    COMMENT "Staging unpacked browser extension and Qt runtime"
)
if(WIN32)
    add_custom_command(TARGET chrome_control_mcp POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "$<TARGET_FILE:Qt6::Core>"
                "$<TARGET_FILE_DIR:chrome_control_mcp>"
        COMMENT "Staging Qt runtime"
    )
endif()

install(TARGETS chrome_control_mcp RUNTIME DESTINATION .)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE" DESTINATION .)
if(WIN32)
    install(FILES "$<TARGET_FILE:Qt6::Core>" DESTINATION .)
endif()
install(DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/browser/extension/" DESTINATION extension)

include(CTest)
if(BUILD_TESTING)
    find_package(Qt6 6.5 REQUIRED COMPONENTS Test)

    function(configure_qt_test target)
        set_target_properties(${target} PROPERTIES AUTOMOC ON)
        target_include_directories(${target} PRIVATE ${CCMCP_INCLUDE_DIR})
        if(WIN32)
            target_compile_definitions(${target} PRIVATE UNICODE _UNICODE)
        elseif(NOT APPLE)
            target_compile_definitions(${target} PRIVATE _GNU_SOURCE)
        endif()
        enable_project_quality(${target})
        if(WIN32)
            add_custom_command(TARGET ${target} POST_BUILD
                COMMAND ${CMAKE_COMMAND} -E copy_if_different
                        "$<TARGET_FILE:Qt6::Core>" "$<TARGET_FILE_DIR:${target}>"
                COMMAND ${CMAKE_COMMAND} -E copy_if_different
                        "$<TARGET_FILE:Qt6::Test>" "$<TARGET_FILE_DIR:${target}>"
            )
        endif()
        add_test(NAME ${target} COMMAND ${target} -o "${target}.txt,txt")
    endfunction()

    add_executable(test_browser_contract
        tests/test_browser_contract.cpp
        src/browser_contract.cpp
    )
    target_link_libraries(test_browser_contract PRIVATE Qt6::Core Qt6::Test)
    configure_qt_test(test_browser_contract)

    add_executable(test_native_messaging
        tests/test_native_messaging.cpp
        src/native_messaging.cpp
        src/native_host.cpp
    )
    target_link_libraries(test_native_messaging PRIVATE Qt6::Core Qt6::Test)
    configure_qt_test(test_native_messaging)

    add_executable(test_browser_bridge
        tests/test_browser_bridge.cpp
        src/browser_bridge.cpp
        src/browser_contract.cpp
    )
    target_link_libraries(test_browser_bridge PRIVATE Qt6::Core Qt6::Test)
    configure_qt_test(test_browser_bridge)

    add_executable(test_browser_extension_installer
        tests/test_browser_extension_installer.cpp
        src/browser_extension_installer.cpp
    )
    target_link_libraries(test_browser_extension_installer PRIVATE Qt6::Core Qt6::Test)
    if(WIN32)
        target_link_libraries(test_browser_extension_installer PRIVATE advapi32)
    endif()
    target_compile_definitions(test_browser_extension_installer PRIVATE
        CHROME_CONTROL_MCP_REPO_ROOT="${CMAKE_CURRENT_SOURCE_DIR}"
    )
    configure_qt_test(test_browser_extension_installer)

    add_executable(test_browser_bridge_security
        tests/test_browser_bridge_security.cpp
        src/browser_bridge_security.cpp
    )
    target_link_libraries(test_browser_bridge_security PRIVATE Qt6::Core Qt6::Test)
    if(WIN32)
        target_link_libraries(test_browser_bridge_security PRIVATE advapi32)
    endif()
    configure_qt_test(test_browser_bridge_security)

    add_executable(test_browser_bridge_pipe
        tests/test_browser_bridge_pipe.cpp
        ${CCMCP_BRIDGE_PIPE_SOURCE}
        src/browser_bridge_security.cpp
        src/native_messaging.cpp
    )
    target_link_libraries(test_browser_bridge_pipe PRIVATE Qt6::Core Qt6::Test Threads::Threads)
    if(WIN32)
        target_link_libraries(test_browser_bridge_pipe PRIVATE advapi32)
    elseif(APPLE)
        target_link_libraries(test_browser_bridge_pipe PRIVATE proc)
    endif()
    configure_qt_test(test_browser_bridge_pipe)

    add_executable(test_browser_bridge_relay
        tests/test_browser_bridge_relay.cpp
        ${CCMCP_BRIDGE_RELAY_SOURCE}
        src/browser_control.cpp
        src/browser_bridge.cpp
        src/browser_contract.cpp
        ${CCMCP_BRIDGE_PIPE_SOURCE}
        src/browser_bridge_security.cpp
        src/native_messaging.cpp
    )
    target_link_libraries(test_browser_bridge_relay PRIVATE Qt6::Core Qt6::Test Threads::Threads)
    if(WIN32)
        target_link_libraries(test_browser_bridge_relay PRIVATE advapi32)
    elseif(APPLE)
        target_link_libraries(test_browser_bridge_relay PRIVATE proc)
    endif()
    configure_qt_test(test_browser_bridge_relay)

    add_executable(test_browser_mcp_server
        tests/test_browser_mcp_server.cpp
        src/browser_mcp_tools.cpp
        src/mcp_dispatch.cpp
    )
    target_link_libraries(test_browser_mcp_server PRIVATE
        chrome_control_mcp_core Qt6::Core Qt6::Test
    )
    configure_qt_test(test_browser_mcp_server)

    find_program(NODE_EXECUTABLE NAMES node REQUIRED)
    add_test(NAME test_browser_extension_pure
        COMMAND "${NODE_EXECUTABLE}" --test
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_browser_extension_pure.mjs"
    )
    set_tests_properties(test_browser_extension_pure PROPERTIES TIMEOUT 120)
endif()
